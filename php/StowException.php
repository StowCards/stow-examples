<?php

declare(strict_types=1);

/**
 * A failed Stow Cards API call.
 *
 * For an API error, `status` is the HTTP status and `errorCode` the API's
 * `error.code` (for example INVALID_API_KEY or STAMP_CARD_FULL), or
 * HTTP_<status> when the body has none. UNEXPECTED_RESPONSE and
 * UNEXPECTED_REDIRECT mean the answer was not the API's. When no response
 * arrived, `status` is 0 and `errorCode` is CONNECTION_ERROR or TIMEOUT.
 * Branch on `errorCode`, show `getMessage()` to people and quote `requestId`
 * to support.
 */
final class StowException extends RuntimeException
{
    /**
     * @param array<string, mixed> $details Extra fields of the error object besides code and message.
     */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $details = [],
        public readonly ?string $requestId = null,
        ?Throwable $previous = null,
    ) {
        $prefix = $status > 0 ? "{$status} {$errorCode}" : $errorCode;
        parent::__construct("{$prefix}: {$message}", 0, $previous);
    }

    /** The message with the request id appended, on one line. */
    public function summary(): string
    {
        $line = $this->getMessage();
        if ($this->requestId !== null && $this->requestId !== '') {
            $line .= " (request id {$this->requestId})";
        }
        return $line;
    }
}
