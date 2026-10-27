using System.Globalization;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Text.Unicode;

namespace StowCards.Example;

/// <summary>
/// A small client for the Stow Cards REST API: authentication, timeouts, safe retries and
/// envelope unwrapping. Failed calls throw <see cref="StowApiException"/>, a call that never got
/// an answer too (<see cref="StowApiException.Status"/> 0, code <c>CONNECTION_ERROR</c> or <c>TIMEOUT</c>).
/// </summary>
public sealed partial class StowClient : IDisposable
{
    public const string DefaultBaseUrl = "https://api.stow.cards/api/v1";
    public const int MaxRetries = 2;
    public static readonly TimeSpan AttemptTimeout = TimeSpan.FromSeconds(30);

    private const string UserAgent = "stowcards-example-dotnet/1.0";
    private const int MaxErrorTextLength = 500;
    private const string UndecodableMessage = "The response body could not be decoded.";
    private static readonly TimeSpan InitialBackoff = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromSeconds(60);

    private static readonly string[] PlainHttpHosts = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"];
    private static readonly char[] AuthorityEnd = ['/', '\\', '?', '#'];
    private static readonly IReadOnlyDictionary<string, JsonElement> NoDetails = new Dictionary<string, JsonElement>();

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly string _apiKey;
    private readonly string _baseUrl;

    public StowClient(string apiKey, string? baseUrl = null)
    {
        var key = apiKey is null ? "" : TrimSpace(apiKey);
        if (key.Length == 0)
        {
            throw new ArgumentException("An API key is required.", nameof(apiKey));
        }
        if (!ApiKeyPattern().IsMatch(key))
        {
            // Never quote the key here, not even in part.
            throw new ArgumentException(
                "The API key (STOW_API_KEY) contains spaces, line breaks or non-ASCII characters such as curly quotes. Copy it again from the web console.");
        }
        _apiKey = key;
        _baseUrl = NormaliseBaseUrl(baseUrl ?? DefaultBaseUrl);
        // Redirects are refused, so the API key is never forwarded to another host.
        _http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false })
        {
            Timeout = Timeout.InfiniteTimeSpan, // each attempt gets its own AttemptTimeout instead
        };
    }

    /// <summary>Reads <c>STOW_API_KEY</c> (required) and <c>STOW_BASE_URL</c> (optional).</summary>
    /// <exception cref="InvalidOperationException">STOW_API_KEY is not set.</exception>
    /// <exception cref="ArgumentException">STOW_API_KEY or STOW_BASE_URL is not acceptable.</exception>
    public static StowClient FromEnvironment()
    {
        var apiKey = Environment.GetEnvironmentVariable("STOW_API_KEY");
        if (apiKey is null || TrimSpace(apiKey).Length == 0)
        {
            throw new InvalidOperationException(
                "STOW_API_KEY is not set. Create a key in the web console (Administration > API Keys) " +
                "and export STOW_API_KEY=stow_...");
        }
        var baseUrl = Environment.GetEnvironmentVariable("STOW_BASE_URL");
        return new StowClient(apiKey, string.IsNullOrWhiteSpace(baseUrl) ? null : baseUrl);
    }

    public string BaseUrl => _baseUrl;

    /// <summary>Called with a short note before each retry. The note never contains the API key.</summary>
    public Action<string>? Log { get; set; }

    // A program id goes in a request body, never in a path, so any non-empty string is one.
    public async Task<IReadOnlyList<StowProgram>> ListProgramsAsync(CancellationToken cancellationToken = default) =>
        await SendAsync<List<StowProgram>>(
                HttpMethod.Get, "/merchants/me/programs", null, null, retrySafe: false,
                programs => programs.TrueForAll(p => p is not null && !string.IsNullOrEmpty(p.Id)), cancellationToken)
            .ConfigureAwait(false);

    /// <summary>
    /// Enrols a customer. Safe to retry: the API dedupes on (programId, email) and answers a repeat
    /// with the existing member and <c>deduped: true</c>.
    /// </summary>
    public Task<Member> EnrollMemberAsync(EnrollMemberRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        return SendAsync<Member>(HttpMethod.Post, "/merchants/me/members", request, null, retrySafe: true, HasId, cancellationToken);
    }

    /// <summary>
    /// Adjusts a member's balance. Make one <paramref name="idempotencyKey"/> per logical gesture
    /// (a UUID works) and pass the same key if you retry the gesture yourself; this client reuses it
    /// on its own retries, so the change can never apply twice.
    /// </summary>
    public Task<PointsAdjustResult> AdjustPointsAsync(
        string memberId,
        AdjustPointsRequest request,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Delta.HasValue == request.Value.HasValue)
        {
            throw new ArgumentException("Send exactly one of Delta or Value.", nameof(request));
        }
        if (idempotencyKey is null || !IdempotencyKeyPattern().IsMatch(idempotencyKey))
        {
            throw new ArgumentException("idempotencyKey must be 8 to 128 characters of [A-Za-z0-9_-].", nameof(idempotencyKey));
        }
        var path = $"/merchants/me/members/{Segment(memberId, nameof(memberId))}/points";
        return SendAsync<PointsAdjustResult>(HttpMethod.Patch, path, request, idempotencyKey, retrySafe: true, null, cancellationToken);
    }

    /// <summary>Reads a member by its <c>id</c> (UUID), not by <c>memberCode</c>.</summary>
    public Task<Member> GetMemberAsync(string memberId, CancellationToken cancellationToken = default) =>
        SendAsync<Member>(
            HttpMethod.Get, $"/merchants/me/members/{Segment(memberId, nameof(memberId))}", null, null, retrySafe: false, HasId, cancellationToken);

    public void Dispose() => _http.Dispose();

    // A GET is retried; any other call only when its method marks it safe to repeat (the deduping
    // enrolment, the keyed points PATCH). An Idempotency-Key alone does not make a call safe: only
    // the endpoints that honour it replay their answer, so an unmarked call is sent once.
    private async Task<T> SendAsync<T>(
        HttpMethod method,
        string path,
        object? body,
        string? idempotencyKey,
        bool retrySafe,
        Func<T, bool>? isValid,
        CancellationToken cancellationToken)
        where T : class
    {
        var payload = body is null ? null : JsonSerializer.SerializeToUtf8Bytes(body, body.GetType(), JsonOptions);
        var label = $"{method} {path}";
        var mayRetry = retrySafe || method == HttpMethod.Get;

        for (var attempt = 0; ; attempt++)
        {
            using var request = BuildRequest(method, path, payload, idempotencyKey);
            // One deadline for the whole attempt: connecting, sending and reading the entire body.
            using var attemptCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            attemptCts.CancelAfter(AttemptTimeout);

            HttpResponseMessage? response = null;
            byte[] bytes;
            try
            {
                response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, attemptCts.Token)
                    .ConfigureAwait(false);
                // A redirect's body is never read: the status alone decides the outcome.
                bytes = IsRedirect(response)
                    ? []
                    : await response.Content.ReadAsByteArrayAsync(attemptCts.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (IsTransportFailure(ex, cancellationToken))
            {
                response?.Dispose();
                if (mayRetry && attempt < MaxRetries)
                {
                    await BackOffAsync(label, attempt, null, Describe(ex), cancellationToken).ConfigureAwait(false);
                    continue;
                }
                throw NoResponse(ex, label, attempt + 1);
            }

            using (response)
            {
                var status = (int)response.StatusCode;
                var requestId = response.Headers.TryGetValues("X-Correlation-Id", out var ids) ? NonBlank(ids.FirstOrDefault()) : null;

                // Redirects are never followed, so the API key never reaches another host.
                if (IsRedirect(response))
                {
                    throw new StowApiException(
                        status,
                        "UNEXPECTED_REDIRECT",
                        "The API answered with a redirect, which this client does not follow. Check that STOW_BASE_URL is the API's https address, including /api/v1.",
                        requestId,
                        NoDetails);
                }
                var decoded = Decode(bytes, response.Content.Headers.ContentEncoding);
                using var document = decoded is null ? null : TryParseJson(decoded);
                var root = document?.RootElement;

                if (response.IsSuccessStatusCode)
                {
                    if (decoded is null) throw Unexpected(status, requestId, UndecodableMessage);
                    return ReadData(root, status, requestId, isValid);
                }

                // An error body that cannot be decoded counts as empty, so the status still decides:
                // a 503 stays a retryable 503.
                var retryAfter = ReadRetryAfter(response);
                var error = CreateError(status, root, decoded ?? [], requestId, retryAfter);
                var retryable = mayRetry && ShouldRetry(status, error.Code, idempotencyKey is not null, attempt);
                if (!retryable || attempt >= MaxRetries || retryAfter > MaxRetryAfter)
                {
                    throw error;
                }
                await BackOffAsync(label, attempt, retryAfter, $"{status} {error.Code}", cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private static bool ShouldRetry(int status, string code, bool hasIdempotencyKey, int attempt)
    {
        // On a retry of a keyed request, IDEMPOTENCY_KEY_IN_USE means our own earlier attempt still
        // holds the key: waiting lets it finish, and the next attempt gets its stored answer. On a
        // first attempt only someone else can hold the key, and every other 409 is a refusal.
        if (status == 409)
        {
            return hasIdempotencyKey && attempt > 0 && code == "IDEMPOTENCY_KEY_IN_USE";
        }
        return status is 408 or 429 or 500 or 502 or 503 or 504;
    }

    private HttpRequestMessage BuildRequest(HttpMethod method, string path, byte[]? payload, string? idempotencyKey)
    {
        var request = new HttpRequestMessage(method, new Uri(_baseUrl + path));
        request.Headers.TryAddWithoutValidation("X-API-Key", _apiKey);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
        if (idempotencyKey is not null)
        {
            request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        }
        if (payload is not null)
        {
            request.Content = new ByteArrayContent(payload);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }
        return request;
    }

    private async Task BackOffAsync(string label, int attempt, TimeSpan? retryAfter, string reason, CancellationToken cancellationToken)
    {
        // Exponential backoff with full jitter, unless the server said how long to wait.
        var ceiling = Math.Min(MaxBackoff.TotalMilliseconds, InitialBackoff.TotalMilliseconds * Math.Pow(2, attempt));
        var delay = retryAfter ?? TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * ceiling);
        Log?.Invoke($"{label}: {reason}; retry {attempt + 1}/{MaxRetries} in {delay.TotalMilliseconds:0} ms");
        await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
    }

    private static T ReadData<T>(JsonElement? root, int status, string? requestId, Func<T, bool>? isValid)
        where T : class
    {
        // A 204 is a success with no data, but every call this client makes needs data.
        if (status == 204)
        {
            throw Unexpected(status, requestId, "The API answered 204 No Content, but this call needs data.");
        }
        if (!IsEnvelope(root, success: true))
        {
            throw Unexpected(status, requestId,
                "The response is not a Stow Cards API response. Check that STOW_BASE_URL points at the API, including /api/v1.");
        }
        T? value = null;
        if (root!.Value.TryGetProperty("data", out var data) && data.ValueKind != JsonValueKind.Null)
        {
            try
            {
                value = data.Deserialize<T>(JsonOptions);
            }
            catch (JsonException)
            {
                // Refused below.
            }
        }
        if (value is null || (isValid is not null && !isValid(value)))
        {
            throw Unexpected(status, requestId, "The API's response has no data, or not data of the expected shape.");
        }
        return value;
    }

    private static StowApiException Unexpected(int status, string? requestId, string message) =>
        new(status, "UNEXPECTED_RESPONSE", message, requestId, NoDetails);

    private static StowApiException CreateError(int status, JsonElement? root, byte[] bytes, string? requestId, TimeSpan? retryAfter)
    {
        var code = $"HTTP_{status}";
        var message = $"Request failed with status {status}";
        var details = new Dictionary<string, JsonElement>();

        // A code or message that is empty, blank or not a string counts as missing.
        if (root is { ValueKind: JsonValueKind.Object } body && body.TryGetProperty("error", out var error))
        {
            if (error.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in error.EnumerateObject())
                {
                    if (property.NameEquals("code"))
                    {
                        code = TextOf(property.Value) ?? code;
                    }
                    else if (property.NameEquals("message"))
                    {
                        message = TextOf(property.Value) ?? message;
                    }
                    else
                    {
                        details[property.Name] = property.Value.Clone();
                    }
                }
            }
            else if (error.ValueKind == JsonValueKind.String)
            {
                // The older flat shape, read as the Node SDK reads it: { "error": "message", "code": "...", ... }.
                message = TextOf(error) ?? message;
                foreach (var property in body.EnumerateObject())
                {
                    if (property.NameEquals("code"))
                    {
                        code = TextOf(property.Value) ?? code;
                    }
                    else if (!property.NameEquals("error") && !property.NameEquals("success") && !property.NameEquals("message"))
                    {
                        details[property.Name] = property.Value.Clone();
                    }
                }
            }
        }
        else if (root is { ValueKind: JsonValueKind.String } text)
        {
            // A bare JSON string is the message; any other JSON that is not an object says nothing.
            message = ErrorText(text.GetString()) ?? message;
        }
        else if (root is null)
        {
            // Not JSON: a proxy's page or plain text.
            message = ErrorText(Encoding.UTF8.GetString(bytes)) ?? message;
        }

        return new StowApiException(status, code, message, requestId, details, retryAfter);
    }

    // Trimmed, then the first 500 characters (never half of a surrogate pair); null when nothing is left.
    private static string? ErrorText(string? value)
    {
        var text = value is null ? "" : TrimSpace(value);
        if (text.Length == 0) return null;
        var cut = text.Length <= MaxErrorTextLength ? text.Length : MaxErrorTextLength - (char.IsHighSurrogate(text[MaxErrorTextLength - 1]) ? 1 : 0);
        return text[..cut];
    }

    // Trims what JavaScript's String.prototype.trim() trims, as the Node SDK does: tab, line feed, vertical
    // tab, form feed, carriage return, U+2028, U+2029, U+FEFF and every Unicode space separator (U+00A0 too).
    private static string TrimSpace(string value)
    {
        var start = 0;
        var end = value.Length;
        while (start < end && IsSurroundingSpace(value[start])) start++;
        while (end > start && IsSurroundingSpace(value[end - 1])) end--;
        return value[start..end];
    }

    private static bool IsSurroundingSpace(char c) =>
        c is '\t' or '\n' or '\v' or '\f' or '\r' or '\u2028' or '\u2029' or '\uFEFF' ||
        char.GetUnicodeCategory(c) == UnicodeCategory.SpaceSeparator;

    private static string? TextOf(JsonElement value) =>
        value.ValueKind == JsonValueKind.String ? NonBlank(value.GetString()) : null;

    // Blank means nothing is left once TrimSpace has run, so it agrees with JavaScript's trim().
    private static string? NonBlank(string? value) => IsBlank(value) ? null : value;

    private static bool IsBlank(string? value) => value is null || TrimSpace(value).Length == 0;

    private static bool IsRedirect(HttpResponseMessage response) => (int)response.StatusCode is >= 300 and < 400;

    private static bool IsEnvelope(JsonElement? root, bool success) =>
        root is { ValueKind: JsonValueKind.Object } element &&
        element.TryGetProperty("success", out var flag) &&
        flag.ValueKind == (success ? JsonValueKind.True : JsonValueKind.False);

    // No Accept-Encoding is sent, but a proxy may compress anyway. Null when the body is corrupt or
    // uses an encoding other than gzip, deflate or br.
    private static byte[]? Decode(byte[] bytes, ICollection<string> encodings)
    {
        if (bytes.Length == 0) return bytes;
        try
        {
            // Encodings are listed in the order they were applied, so they are undone last first.
            foreach (var encoding in encodings.Reverse())
            {
                if (encoding.Equals("identity", StringComparison.OrdinalIgnoreCase)) continue;
                using var input = new MemoryStream(bytes);
                using Stream decoder =
                    encoding.Equals("gzip", StringComparison.OrdinalIgnoreCase) || encoding.Equals("x-gzip", StringComparison.OrdinalIgnoreCase)
                        ? new GZipStream(input, CompressionMode.Decompress)
                        : encoding.Equals("deflate", StringComparison.OrdinalIgnoreCase) ? new ZLibStream(input, CompressionMode.Decompress)
                        : encoding.Equals("br", StringComparison.OrdinalIgnoreCase) ? new BrotliStream(input, CompressionMode.Decompress)
                        : throw new InvalidDataException();
                using var output = new MemoryStream();
                decoder.CopyTo(output);
                bytes = output.ToArray();
            }
            return bytes;
        }
        catch (Exception)
        {
            // Any failure counts as undecodable: each decoder reports bad input its own way
            // (GZipStream and ZLibStream throw InvalidDataException, BrotliStream InvalidOperationException).
            return null;
        }
    }

    private static JsonDocument? TryParseJson(byte[] bytes)
    {
        var json = bytes.AsMemory();
        if (json.Span.StartsWith("\uFEFF"u8)) json = json[3..];
        // Invalid UTF-8 is never JSON: JsonDocument would only notice it when a value is read.
        if (json.Span.Trim(" \t\r\n"u8).IsEmpty || !Utf8.IsValid(json.Span)) return null;
        try
        {
            return JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // Retry-After as delay-seconds or an HTTP-date. Delay-seconds is a plain decimal, read the way the
    // Node SDK's Number() reads one: "5", "5.0", ".5" and "5." (no sign, exponent or inner space).
    // Anything else is ignored, so the normal backoff applies.
    private static TimeSpan? ReadRetryAfter(HttpResponseMessage response)
    {
        if (!response.Headers.NonValidated.TryGetValues("Retry-After", out var values)) return null;
        var value = values.FirstOrDefault()?.Trim();
        if (string.IsNullOrEmpty(value)) return null;
        if (DelaySecondsPattern().IsMatch(value) &&
            double.TryParse(value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var seconds))
        {
            // Clamped at a day so TimeSpan cannot overflow; anything over 60 s fails at once anyway.
            return TimeSpan.FromSeconds(Math.Min(seconds, 86_400));
        }
        if (RetryConditionHeaderValue.TryParse(value, out var parsed) && parsed.Date is { } date)
        {
            var wait = date - DateTimeOffset.UtcNow;
            return wait > TimeSpan.Zero ? wait : TimeSpan.Zero;
        }
        return null;
    }

    // A network error or a per-attempt timeout; a cancellation the caller asked for is not one.
    private static bool IsTransportFailure(Exception ex, CancellationToken cancellationToken) =>
        ex is HttpRequestException or IOException || (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested);

    // No response arrived: status 0, code TIMEOUT or CONNECTION_ERROR, the cause as InnerException.
    private StowApiException NoResponse(Exception ex, string label, int attempts)
    {
        var count = attempts == 1 ? "1 attempt" : $"{attempts} attempts";
        return ex is OperationCanceledException
            ? new StowApiException(
                0, "TIMEOUT", $"No complete response from {_baseUrl} to {label} within {AttemptTimeout.TotalSeconds:0} s, {count}.",
                null, NoDetails, innerException: ex)
            : new StowApiException(
                0, "CONNECTION_ERROR", $"No response from {_baseUrl} to {label} after {count}: {Describe(ex)}",
                null, NoDetails, innerException: ex);
    }

    private static string Describe(Exception ex) =>
        ex is OperationCanceledException ? "timed out" : ex.InnerException?.Message ?? ex.Message;

    private static bool HasId(Member member) => IsSegment(member.Id);

    // Not blank, and not "." or "..", which Uri would resolve into another endpoint.
    private static bool IsSegment(string? value) => !IsBlank(value) && value is not ("." or "..");

    private static string Segment(string value, string name)
    {
        if (!IsSegment(value))
        {
            throw new ArgumentException($"{name} must be a non-empty identifier.", name);
        }
        return Uri.EscapeDataString(value);
    }

    private static string NormaliseBaseUrl(string value)
    {
        var text = value.Trim();
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) ||
            !text.Contains("://", StringComparison.Ordinal))
        {
            throw new ArgumentException("The base URL (STOW_BASE_URL) must be an absolute https URL, such as " + DefaultBaseUrl + ".");
        }
        // The authority as written: Uri hides an empty user name ("http://@host") and rewrites hosts such as 127.1.
        var authority = text[(text.IndexOf("://", StringComparison.Ordinal) + 3)..];
        var end = authority.IndexOfAny(AuthorityEnd);
        authority = end < 0 ? authority : authority[..end];
        if (authority.Contains('@', StringComparison.Ordinal) || uri.Query.Length > 0 || uri.Fragment.Length > 0)
        {
            throw new ArgumentException("The base URL (STOW_BASE_URL) must not contain credentials, a query string or a fragment.");
        }
        // The port as written, too: Uri reads an empty one ("localhost:") as the scheme's default.
        var colon = authority.IndexOf(':', authority.StartsWith('[') ? Math.Max(0, authority.IndexOf(']', StringComparison.Ordinal)) : 0);
        var host = colon < 0 ? authority : authority[..colon];
        if (colon >= 0 &&
            !(int.TryParse(authority[(colon + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var port) && port is >= 1 and <= 65535))
        {
            throw new ArgumentException("The base URL (STOW_BASE_URL) has an invalid port.");
        }
        if (uri.Scheme == Uri.UriSchemeHttp && !(IsPlainHttpHost(host) && IsPlainHttpHost(uri.Host)))
        {
            throw new ArgumentException(
                "The base URL (STOW_BASE_URL) must use https, so the API key is never sent unencrypted. Plain http is allowed only for " +
                "localhost, 127.0.0.1, [::1], names ending in .localhost and host.docker.internal.");
        }
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    private static bool IsPlainHttpHost(string host) =>
        PlainHttpHosts.Contains(host, StringComparer.OrdinalIgnoreCase) ||
        (host.Length > ".localhost".Length && host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase));

    [GeneratedRegex(@"\A[A-Za-z0-9_-]{8,128}\z")]
    private static partial Regex IdempotencyKeyPattern();

    [GeneratedRegex(@"\A[\x21-\x7E]+\z")]
    private static partial Regex ApiKeyPattern();

    [GeneratedRegex(@"\A(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)\z")]
    private static partial Regex DelaySecondsPattern();
}
