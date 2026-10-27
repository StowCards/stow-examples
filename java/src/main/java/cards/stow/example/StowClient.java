package cards.stow.example;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoField;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * A small client for the Stow Cards REST API: API-key authentication, envelope unwrapping,
 * typed errors and safe retries. Create one and reuse it; it is safe to share between threads.
 *
 * <p>Every failure throws {@link StowApiException}. When no response arrived (once the retries
 * are spent), its status is 0 and its code {@code CONNECTION_ERROR} or {@code TIMEOUT}.
 * A bad API key or base URL throws {@link IllegalStateException} from the constructor, and an
 * empty or whitespace-only member id {@link IllegalArgumentException} before anything is sent.
 */
public final class StowClient {

    public static final String DEFAULT_BASE_URL = "https://api.stow.cards/api/v1";

    private static final String USER_AGENT = "stowcards-example-java/1.0";
    private static final Duration TIMEOUT = Duration.ofSeconds(30);
    private static final int MAX_RETRIES = 2;
    private static final long INITIAL_BACKOFF_MS = 500;
    private static final long MAX_BACKOFF_MS = 8_000;
    private static final long MAX_RETRY_AFTER_MS = 60_000;
    // host.docker.internal is allowed only so the example can be checked from a Docker
    // container against a mock gateway on the host. Everything else must use https.
    private static final Set<String> PLAIN_HTTP_HOSTS = Set.of("localhost", "127.0.0.1", "[::1]", "host.docker.internal");
    private static final Set<Integer> RETRYABLE_STATUSES = Set.of(408, 429, 500, 502, 503, 504);
    private static final Pattern API_KEY = Pattern.compile("[\\x21-\\x7e]+");
    // What JavaScript's trim() removes: Unicode space separators (no-break spaces included), BOM, line breaks.
    private static final Pattern SURROUNDING_SPACE = Pattern.compile(
            "\\A[\\t\\n\\x0B\\f\\r\\uFEFF\\u2028\\u2029\\p{Zs}]+|[\\t\\n\\x0B\\f\\r\\uFEFF\\u2028\\u2029\\p{Zs}]+\\z");
    private static final Pattern IDEMPOTENCY_KEY = Pattern.compile("[A-Za-z0-9_-]{8,128}");
    private static final Pattern SECONDS = Pattern.compile("[0-9]+(\\.[0-9]*)?|\\.[0-9]+"); // "5", "1.5", ".5", "5."
    // The three HTTP-date forms of RFC 9110: IMF-fixdate, then the obsolete RFC 850 and asctime forms.
    private static final List<DateTimeFormatter> HTTP_DATES = List.of(
            DateTimeFormatter.RFC_1123_DATE_TIME,
            new DateTimeFormatterBuilder().appendPattern("EEEE, dd-MMM-")
                    .appendValueReduced(ChronoField.YEAR, 2, 2, 1970)
                    .appendPattern(" HH:mm:ss zzz").toFormatter(Locale.ENGLISH),
            DateTimeFormatter.ofPattern("EEE MMM ppd HH:mm:ss yyyy", Locale.ENGLISH).withZone(ZoneOffset.UTC));
    // Every Unicode space and line break (U+0085, U+2028 and U+2029 included), other control characters and BOM.
    private static final Pattern NOT_ONE_LINE = Pattern.compile("[\\p{Z}\\p{Cc}\\uFEFF]+");
    private static final int MAX_TEXT_MESSAGE = 500;

    // The shape each call needs in "data"; anything else is UNEXPECTED_RESPONSE.
    private static final Predicate<JsonNode> OBJECT = JsonNode::isObject;
    private static final Predicate<JsonNode> MEMBER = data -> data.isObject() && data.path("id").isTextual()
            && isMemberId(data.get("id").textValue());
    private static final Predicate<JsonNode> PROGRAMS = data -> {
        if (!data.isArray()) {
            return false;
        }
        for (JsonNode item : data) {
            // The program id goes in a request body, never a path, so any non-empty string will do.
            if (!item.isObject() || !item.path("_id").isTextual() || item.get("_id").textValue().isEmpty()) {
                return false;
            }
        }
        return true;
    };

    private static final ObjectMapper JSON = JsonMapper.builder()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS) // so "502 Bad Gateway" is text, not 502
            .build();

    private final String apiKey;
    private final String baseUrl;
    private final HttpClient http;
    private volatile Consumer<String> onRetry = note -> { };

    public StowClient(String apiKey, String baseUrl) {
        String key = apiKey == null ? "" : trim(apiKey);
        if (key.isEmpty()) {
            throw new IllegalStateException("The API key is missing.");
        }
        // Never quote the key, or any part of it, in a message.
        if (!API_KEY.matcher(key).matches()) {
            throw new IllegalStateException("The API key may contain only visible ASCII characters: no spaces, "
                    + "line breaks or curly quotes. Copy it again from the console.");
        }
        this.apiKey = key;
        String url = baseUrl == null ? "" : trim(baseUrl);
        this.baseUrl = checkBaseUrl(url.isEmpty() ? DEFAULT_BASE_URL : url);
        this.http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1) // no h2c upgrade headers on plain http to a local gateway
                .connectTimeout(TIMEOUT)
                .followRedirects(HttpClient.Redirect.NEVER) // never forward the key to another host
                .build();
    }

    /** Reads {@code STOW_API_KEY} (required) and {@code STOW_BASE_URL} (optional). */
    public static StowClient fromEnvironment() {
        String key = System.getenv("STOW_API_KEY");
        if (key == null || trim(key).isEmpty()) {
            throw new IllegalStateException("STOW_API_KEY is not set. Create a key in the Stow Cards console "
                    + "(Administration, API Keys) and export it as STOW_API_KEY.");
        }
        return new StowClient(key, System.getenv("STOW_BASE_URL"));
    }

    public String baseUrl() {
        return baseUrl;
    }

    /**
     * Sets what is called with a one-line note before each retry, such as
     * {@code "PATCH /merchants/me/members/{id}/points: 503 SERVICE_UNAVAILABLE; retry 1 of 2 in 300 ms"}.
     * The note never contains the API key. By default retries are silent.
     */
    public void onRetry(Consumer<String> listener) {
        this.onRetry = Objects.requireNonNull(listener, "listener");
    }

    @Override
    public String toString() {
        return "StowClient[baseUrl=" + baseUrl + "]";
    }

    // ---- API calls -------------------------------------------------------------------------

    public List<Program> listPrograms() throws IOException, InterruptedException {
        return call("GET", "/merchants/me/programs", null, null, true, PROGRAMS,
                new TypeReference<List<Program>>() { });
    }

    /**
     * Enrolment dedupes on (programId, email): a retry returns the member the first attempt
     * created, with {@code deduped: true}, so it is safe to retry.
     */
    public Member enrollMember(EnrollRequest request) throws IOException, InterruptedException {
        return call("POST", "/merchants/me/members", request, null, true, MEMBER, new TypeReference<Member>() { });
    }

    /**
     * Adds {@code delta} points. Use one {@code idempotencyKey} per gesture: every retry of the
     * gesture, including the automatic ones here, must resend the same key.
     */
    public PointsResult adjustPoints(String memberId, int delta, String changeMessage, String idempotencyKey)
            throws IOException, InterruptedException {
        if (idempotencyKey == null || !IDEMPOTENCY_KEY.matcher(idempotencyKey).matches()) {
            throw new IllegalArgumentException("idempotencyKey must be 8 to 128 characters of [A-Za-z0-9_-].");
        }
        return call("PATCH", "/merchants/me/members/" + segment(memberId) + "/points",
                new PointsRequest(delta, changeMessage), idempotencyKey, true, OBJECT,
                new TypeReference<PointsResult>() { });
    }

    public Member getMember(String memberId) throws IOException, InterruptedException {
        return call("GET", "/merchants/me/members/" + segment(memberId), null, null, true, MEMBER,
                new TypeReference<Member>() { });
    }

    // ---- Transport -------------------------------------------------------------------------

    private <T> T call(String method, String path, Object body, String idempotencyKey, boolean retryable,
                       Predicate<JsonNode> shape, TypeReference<T> type) throws IOException, InterruptedException {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(TIMEOUT)
                .header("X-API-Key", apiKey)
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity") // see readable()
                .header("User-Agent", USER_AGENT);
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("Content-Type", "application/json")
                    .method(method, HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        }
        if (idempotencyKey != null) {
            builder.header("Idempotency-Key", idempotencyKey);
        }
        HttpRequest request = builder.build(); // built once, so every attempt sends the same key
        String label = method + " " + path;

        for (int attempt = 0; ; attempt++) {
            boolean mayRetry = retryable && attempt < MAX_RETRIES;
            HttpResponse<String> response;
            try {
                response = send(request);
            } catch (IOException e) { // no response: connection failures and timeouts
                if (!mayRetry) {
                    throw noResponse(label, attempt + 1, e);
                }
                pause(label, describe(e), backoffMs(attempt), attempt);
                continue;
            }

            int status = response.statusCode();
            String requestId = response.headers().firstValue("X-Correlation-Id").map(StowClient::oneLine)
                    .filter(id -> !id.isEmpty()).orElse(null);
            String text = readable(response) ? response.body() : null;
            JsonNode json = parse(text);
            if (status == 204 || (status / 100 == 2 && json != null && json.path("success").booleanValue())) {
                return unwrap(status, status == 204 ? null : json.get("data"), shape, type, requestId);
            }

            StowApiException error = toError(status, json, text, requestId);
            Long wait = retryAfterMs(response); // null when absent or unreadable: back off as usual
            boolean worthRetrying = RETRYABLE_STATUSES.contains(status)
                    || keyStillHeldByOurEarlierAttempt(status, error.code(), idempotencyKey, attempt);
            if (!mayRetry || !worthRetrying || (wait != null && wait > MAX_RETRY_AFTER_MS)) {
                throw error;
            }
            pause(label, status + " " + error.code(), wait != null ? wait : backoffMs(attempt), attempt);
        }
    }

    /** One attempt, bounded as a whole (headers and body) by the timeout. */
    private HttpResponse<String> send(HttpRequest request) throws IOException, InterruptedException {
        CompletableFuture<HttpResponse<String>> future = http.sendAsync(request, HttpResponse.BodyHandlers.ofString());
        try {
            return future.get(TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            throw new HttpTimeoutException("no complete response within " + TIMEOUT.toSeconds() + " s");
        } catch (InterruptedException e) {
            future.cancel(true);
            throw e;
        } catch (ExecutionException e) {
            if (e.getCause() instanceof IOException cause) {
                throw cause;
            }
            if (e.getCause() instanceof RuntimeException cause) {
                throw cause;
            }
            throw new IOException(e.getCause());
        }
    }

    /** A 204 has no data; every call here needs some, so it is as unexpected as data of the wrong shape. */
    private static <T> T unwrap(int status, JsonNode data, Predicate<JsonNode> shape, TypeReference<T> type,
                                String requestId) {
        if (data == null || data.isNull()) {
            throw new StowApiException(status, "UNEXPECTED_RESPONSE", "The response has no data.", null, requestId);
        }
        if (!shape.test(data)) {
            throw new StowApiException(status, "UNEXPECTED_RESPONSE", "The response data has an unexpected shape.",
                    null, requestId);
        }
        try {
            return JSON.readerFor(type).readValue(data);
        } catch (IOException e) {
            String reason = e instanceof JsonProcessingException j ? j.getOriginalMessage() : e.getMessage();
            throw new StowApiException(status, "UNEXPECTED_RESPONSE",
                    "Could not read the response data: " + oneLine(reason), null, requestId);
        }
    }

    private static StowApiException noResponse(String label, int attempts, IOException e) {
        boolean timeout = e instanceof HttpTimeoutException;
        String message = timeout
                ? "No complete response to " + label + " within " + TIMEOUT.toSeconds() + " s (" + attempts + " attempt(s))"
                : "No response to " + label + " after " + attempts + " attempt(s): " + describe(e);
        StowApiException error = new StowApiException(0, timeout ? "TIMEOUT" : "CONNECTION_ERROR", message, null, null);
        error.initCause(e);
        return error;
    }

    /** The status decides first; {@code body} is null when it could not be decoded. */
    private static StowApiException toError(int status, JsonNode json, String body, String requestId) {
        if (status / 100 == 3) {
            return new StowApiException(status, "UNEXPECTED_REDIRECT", "The server answered with a redirect, which "
                    + "this client never follows. Check STOW_BASE_URL.", null, requestId);
        }
        if (status / 100 == 2) {
            return new StowApiException(status, "UNEXPECTED_RESPONSE", body == null
                    ? "The response body could not be decoded."
                    : "The response is not a Stow Cards API response. Check that STOW_BASE_URL points at the API, "
                    + "including /api/v1.", null, requestId);
        }
        JsonNode error = json == null ? null : json.get("error");
        if (error != null && (error.isObject() || error.isTextual())) {
            // The documented error object, or the flat {"error": message, "code": ...} older gateways sent.
            // A code or message is kept as received unless it is blank.
            boolean flat = error.isTextual();
            JsonNode fields = flat ? json : error;
            String code = nonBlank(fields.get("code"));
            String message = nonBlank(flat ? error : error.get("message"));
            code = code == null ? "HTTP_" + status : code;
            message = message == null ? "Request failed with status " + status : message;
            Set<String> skip = flat ? Set.of("success", "error", "code", "message") : Set.of("code", "message");
            Map<String, Object> details = new LinkedHashMap<>();
            for (Map.Entry<String, JsonNode> field : fields.properties()) {
                if (!skip.contains(field.getKey())) {
                    details.put(field.getKey(), JSON.convertValue(field.getValue(), Object.class));
                }
            }
            return new StowApiException(status, code, message, details, requestId);
        }
        // A body that is not JSON (a proxy's text or HTML page, say), or is a bare JSON string, is the best
        // message there is; other JSON without an error is not.
        String text = json == null ? (body == null ? "" : trim(body)) : json.isTextual() ? trim(json.textValue()) : "";
        String message = text.isEmpty() ? "Request failed with status " + status : firstChars(text, MAX_TEXT_MESSAGE);
        return new StowApiException(status, "HTTP_" + status, message, null, requestId);
    }

    /**
     * On a retry of a keyed request, {@code IDEMPOTENCY_KEY_IN_USE} means the attempt we stopped
     * waiting for still holds the key; waiting lets it finish and the next attempt gets its stored
     * answer. Any other 409, or one on a first attempt, is a refusal and is never retried.
     */
    private static boolean keyStillHeldByOurEarlierAttempt(int status, String code, String idempotencyKey,
                                                           int attempt) {
        return status == 409 && idempotencyKey != null && attempt > 0 && "IDEMPOTENCY_KEY_IN_USE".equals(code);
    }

    /** Exponential backoff with full jitter: a random wait between 0 and the ceiling. */
    private static long backoffMs(int attempt) {
        long ceiling = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS << attempt);
        return ThreadLocalRandom.current().nextLong(ceiling + 1);
    }

    /** The server's {@code Retry-After} (seconds or an HTTP date) in milliseconds, or null when unreadable. */
    private static Long retryAfterMs(HttpResponse<?> response) {
        String value = response.headers().firstValue("Retry-After").map(StowClient::trim).orElse("");
        if (SECONDS.matcher(value).matches()) {
            return (long) Math.ceil(Double.parseDouble(value) * 1000);
        }
        for (DateTimeFormatter format : HTTP_DATES) {
            try {
                long at = ZonedDateTime.parse(value, format).toInstant().toEpochMilli();
                return Math.max(0, at - System.currentTimeMillis());
            } catch (DateTimeParseException e) {
                // try the next form
            }
        }
        return null;
    }

    private void pause(String label, String reason, long delayMs, int attempt) throws InterruptedException {
        onRetry.accept(oneLine(String.format("%s: %s; retry %d of %d in %d ms", label, reason, attempt + 1, MAX_RETRIES,
                delayMs)));
        Thread.sleep(delayMs);
    }

    /** The client sends {@code Accept-Encoding: identity}, so a body in any other content coding is not read. */
    private static boolean readable(HttpResponse<?> response) {
        String coding = response.headers().firstValue("Content-Encoding").map(String::strip).orElse("");
        return coding.isEmpty() || coding.equalsIgnoreCase("identity");
    }

    private static boolean hasId(JsonNode node, String field) {
        return node.isObject() && node.path(field).isTextual() && !trim(node.get(field).textValue()).isEmpty();
    }

    private static String trim(String value) {
        return SURROUNDING_SPACE.matcher(value).replaceAll("");
    }

    /** The body as JSON, or null when it is empty or not JSON. */
    private static JsonNode parse(String body) {
        if (body == null || body.isBlank()) {
            return null;
        }
        try {
            return JSON.readTree(body);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    /** The string as received, or null when it is not a string or is blank (empty once trimmed). */
    private static String nonBlank(JsonNode node) {
        return node != null && node.isTextual() && !trim(node.textValue()).isEmpty() ? node.textValue() : null;
    }

    private static String firstChars(String text, int max) {
        return text.codePointCount(0, text.length()) <= max ? text : text.substring(0, text.offsetByCodePoints(0, max));
    }

    /** Collapses whitespace, line breaks and control characters to single spaces; what trim() removes is in that set. */
    private static String oneLine(String value) {
        return value == null ? "" : NOT_ONE_LINE.matcher(value).replaceAll(" ").strip();
    }

    /** The JDK's connection errors often have no message, so name the cause instead. */
    private static String describe(Throwable e) {
        String name = e.getClass().getSimpleName();
        if (e.getMessage() != null) {
            return name + ": " + oneLine(e.getMessage());
        }
        return e.getCause() == null || e.getCause() == e ? name : name + " (" + describe(e.getCause()) + ")";
    }

    /** A member id as one path segment; an empty or whitespace-only id is refused before anything is sent. */
    /** "." and ".." would resolve to another endpoint once placed in the path. */
    private static boolean isMemberId(String value) {
        if (value == null) {
            return false;
        }
        String trimmed = trim(value);
        return !trimmed.isEmpty() && !trimmed.equals(".") && !trimmed.equals("..");
    }

    private static String segment(String memberId) {
        if (!isMemberId(memberId)) {
            throw new IllegalArgumentException("memberId must not be empty, whitespace, \".\" or \"..\".");
        }
        return URLEncoder.encode(memberId, StandardCharsets.UTF_8).replace("+", "%20");
    }

    /** Error messages never quote the URL, which could hold credentials. */
    private static String checkBaseUrl(String value) {
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException e) {
            throw new IllegalStateException("STOW_BASE_URL is not a valid URL.");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (!(scheme.equals("https") || scheme.equals("http")) || host.isEmpty()) {
            throw new IllegalStateException("STOW_BASE_URL must be a full https:// URL such as " + DEFAULT_BASE_URL + ".");
        }
        if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalStateException("STOW_BASE_URL must not contain credentials, a query string or a fragment.");
        }
        String authority = uri.getRawAuthority();
        if (uri.getPort() == 0 || uri.getPort() > 65535 || authority.endsWith(":")) { // ":" alone is an empty port
            throw new IllegalStateException("STOW_BASE_URL has an invalid port.");
        }
        if (scheme.equals("http") && !PLAIN_HTTP_HOSTS.contains(host) && !host.endsWith(".localhost")) {
            throw new IllegalStateException("STOW_BASE_URL must use https:// so the API key is never sent unencrypted "
                    + "(plain http:// is accepted only for localhost, 127.0.0.1, [::1], names ending in .localhost "
                    + "and host.docker.internal).");
        }
        return value.replaceAll("/+$", "");
    }

    // ---- Request and response types (unknown fields are ignored) -------------------------------

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record EnrollRequest(String programId, String firstName, String lastName, String email,
                                Integer initialPoints) { }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PointsRequest(int delta, String changeMessage) { }

    /** A program. Programs are keyed by {@code _id}; members by {@code id}. */
    public record Program(@JsonProperty("_id") String id, String name, String status, String programType,
                          @JsonDeserialize(using = StringOrNull.class) String balanceKey) { }

    /**
     * A member. {@code memberCode} is the "Member ID" to show people; {@code id} is for API paths
     * only. {@code fieldValues} holds the balance, as a number or a numeric string.
     */
    public record Member(String id, String memberCode, String firstName, String lastName, String email,
                         String status, Map<String, Object> fieldValues, AppleWallet apple, GoogleWallet google,
                         PassIssuance passIssuance, ProgramSummary program, boolean deduped) { }

    public record AppleWallet(String passUrl, Boolean installed, String mode) { }

    public record GoogleWallet(String saveUrl, Boolean installed, String mode) { }

    public record PassIssuance(Boolean apple, Boolean google) { }

    public record ProgramSummary(String id, String name, @JsonDeserialize(using = StringOrNull.class) String balanceKey) { }

    public record PointsResult(Member member, Integer previous, Integer current) { }

    /** A {@code balanceKey} that is not a JSON string reads as null, the same as a missing one. */
    static final class StringOrNull extends JsonDeserializer<String> {
        @Override
        public String deserialize(JsonParser parser, DeserializationContext context) throws IOException {
            if (parser.currentToken() == JsonToken.VALUE_STRING) {
                return parser.getText();
            }
            parser.skipChildren();
            return null;
        }
    }
}
