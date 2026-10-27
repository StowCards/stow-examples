using System.Text.Json;

namespace StowCards.Example;

/// <summary>
/// The API answered with an error, or with something that is not an API answer (codes
/// <c>UNEXPECTED_RESPONSE</c> and <c>UNEXPECTED_REDIRECT</c>), or no answer arrived at all
/// (<see cref="Status"/> 0, codes <c>CONNECTION_ERROR</c> and <c>TIMEOUT</c>). Branch on <see cref="Code"/>, show
/// <see cref="ApiMessage"/> to people, and quote <see cref="RequestId"/> when contacting support.
/// </summary>
public sealed class StowApiException : Exception
{
    public StowApiException(
        int status,
        string code,
        string apiMessage,
        string? requestId,
        IReadOnlyDictionary<string, JsonElement> details,
        TimeSpan? retryAfter = null,
        Exception? innerException = null)
        : base(status > 0 ? $"{status} {code}: {apiMessage}" : $"{code}: {apiMessage}", innerException)
    {
        Status = status;
        Code = code;
        ApiMessage = apiMessage;
        RequestId = requestId;
        Details = details;
        RetryAfter = retryAfter;
    }

    /// <summary>HTTP status code, or 0 when no response arrived.</summary>
    public int Status { get; }

    /// <summary>
    /// Machine-readable <c>error.code</c>, e.g. <c>INVALID_API_KEY</c>; <c>HTTP_{status}</c> when the body had none,
    /// only a blank one, or could not be decoded; <c>UNEXPECTED_RESPONSE</c> for a 2xx that is not the API's
    /// envelope, lacks the data the call needs or cannot be decoded;
    /// <c>UNEXPECTED_REDIRECT</c> for a 3xx, which is never followed; <c>CONNECTION_ERROR</c> or
    /// <c>TIMEOUT</c> when no response arrived (the cause is <see cref="Exception.InnerException"/>).
    /// </summary>
    public string Code { get; }

    /// <summary>
    /// Human-readable <c>error.message</c>, or the first 500 characters of a body that is not JSON or is a bare
    /// JSON string, else <c>Request failed with status {status}</c>.
    /// </summary>
    public string ApiMessage { get; }

    /// <summary>The <c>X-Correlation-Id</c> response header.</summary>
    public string? RequestId { get; }

    /// <summary>Fields on the error object besides <c>code</c> and <c>message</c>.</summary>
    public IReadOnlyDictionary<string, JsonElement> Details { get; }

    /// <summary>The wait the server asked for (<c>Retry-After</c>), when it sent one.</summary>
    public TimeSpan? RetryAfter { get; }
}
