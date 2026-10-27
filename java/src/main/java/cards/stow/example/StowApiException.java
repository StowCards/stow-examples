package cards.stow.example;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The Stow Cards API answered with an error or with a body that is not the API's envelope, or
 * no response arrived (status 0, code {@code CONNECTION_ERROR} or {@code TIMEOUT}).
 * Branch on {@link #code()}, show {@link #apiMessage()} to people and quote
 * {@link #requestId()} when contacting support.
 */
public class StowApiException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int status;
    private final String code;
    private final String apiMessage;
    private final transient Map<String, Object> details;
    private final String requestId;

    public StowApiException(int status, String code, String apiMessage, Map<String, Object> details, String requestId) {
        super((status == 0 ? "" : status + " ") + code + ": " + apiMessage
                + (requestId == null ? "" : " (request id " + requestId + ")"));
        this.status = status;
        this.code = code;
        this.apiMessage = apiMessage;
        this.details = details == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(details));
        this.requestId = requestId;
    }

    /** HTTP status code, or 0 when no response arrived. */
    public int status() {
        return status;
    }

    /** Stable, machine-readable code such as {@code INVALID_API_KEY}, {@code NOT_FOUND} or {@code TIMEOUT}. */
    public String code() {
        return code;
    }

    /** Human-readable message: the API's as received, or the client's when the API gave none or a blank one. */
    public String apiMessage() {
        return apiMessage;
    }

    /** Fields of the error object besides {@code code} and {@code message} (of the body, for the older flat shape). */
    public Map<String, Object> details() {
        return details == null ? Map.of() : details; // null only after Java deserialisation
    }

    /** The {@code X-Correlation-Id} response header, or null when the response had none. */
    public String requestId() {
        return requestId;
    }
}
