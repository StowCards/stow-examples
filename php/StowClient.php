<?php

declare(strict_types=1);

require_once __DIR__ . '/StowException.php';

/**
 * A small client for the Stow Cards public REST API.
 *
 * PHP 8.2+ with ext-curl, no Composer packages. Every method returns the
 * `data` of the `{ "success": true, "data": ... }` envelope and throws a
 * StowException on failure.
 */
final class StowClient
{
    public const DEFAULT_BASE_URL = 'https://api.stow.cards/api/v1';
    public const USER_AGENT = 'stowcards-example-php/1.0';

    private const INITIAL_BACKOFF_MS = 500;
    private const MAX_BACKOFF_MS = 8000;
    private const MAX_RETRY_AFTER_MS = 60_000;
    private const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];
    private const IDEMPOTENCY_KEY_PATTERN = '/^[A-Za-z0-9_-]{8,128}$/D';
    private const HOST_NAME_PATTERN = '/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/D';
    // host.docker.internal lets the example run in a container against a gateway on the host.
    private const PLAIN_HTTP_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'];
    private const HTTP_DATE_FORMATS = ['D, d M Y H:i:s \G\M\T', 'l, d-M-y H:i:s \G\M\T', 'D M j H:i:s Y'];
    // Delay-seconds: digits with an optional dot ("5", "5.", "5.0", ".5"), no sign or exponent.
    private const DELAY_SECONDS_PATTERN = '/^(?:\d+\.?\d*|\.\d+)$/D';
    // The whitespace JavaScript's trim() removes (ASCII, no-break and other Unicode spaces,
    // line separators, BOM), so a pasted key or id is judged as the Node SDK judges it.
    private const SPACE = '[\x{9}-\x{D}\x{20}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]';

    // Hidden from var_dump, print_r, var_export and debug_zval_dump; serialize() refuses it.
    private readonly SensitiveParameterValue $apiKey;
    private readonly string $baseUrl;

    /**
     * @param int          $timeoutSeconds Limit for each attempt, including reading the response.
     * @param int          $maxRetries     Retries after the first attempt.
     * @param Closure|null $onRetry        Receives a one-line notice before each retry.
     */
    public function __construct(
        #[\SensitiveParameter] string $apiKey,
        string $baseUrl = self::DEFAULT_BASE_URL,
        private readonly int $timeoutSeconds = 30,
        private readonly int $maxRetries = 2,
        private readonly ?Closure $onRetry = null,
    ) {
        $apiKey = self::trimSpace($apiKey);
        if ($apiKey === '') {
            throw new InvalidArgumentException('An API key is required.');
        }
        if (preg_match('/^[\x21-\x7E]+$/D', $apiKey) !== 1) {
            throw new InvalidArgumentException('The API key may contain only visible ASCII characters (no spaces, line breaks or curly quotes).');
        }
        if ($timeoutSeconds < 1) {
            throw new InvalidArgumentException('timeoutSeconds must be a positive whole number of seconds.');
        }
        if ($maxRetries < 0) {
            throw new InvalidArgumentException('maxRetries must be 0 or more.');
        }
        $this->apiKey = new SensitiveParameterValue($apiKey);
        $this->baseUrl = self::normaliseBaseUrl($baseUrl);
    }

    /** Build a client from STOW_API_KEY and STOW_BASE_URL. */
    public static function fromEnvironment(?Closure $onRetry = null): self
    {
        if (self::trimSpace((string) getenv('STOW_API_KEY')) === '') {
            throw new InvalidArgumentException(
                'STOW_API_KEY is not set. Create a key in the web console (Administration, API Keys) and export it.'
            );
        }
        $baseUrl = trim((string) getenv('STOW_BASE_URL'));

        return new self((string) getenv('STOW_API_KEY'), $baseUrl === '' ? self::DEFAULT_BASE_URL : $baseUrl, onRetry: $onRetry);
    }

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        return ['baseUrl' => $this->baseUrl, 'timeoutSeconds' => $this->timeoutSeconds, 'maxRetries' => $this->maxRetries];
    }

    /** @return list<array<string, mixed>> */
    public function listPrograms(): array
    {
        [$status, $data, $requestId] = $this->execute('GET', '/merchants/me/programs');
        // JSON objects decode as stdClass, so an array here is a JSON list.
        if (!is_array($data)) {
            throw self::unexpectedShape($status, $requestId);
        }
        return array_map(static fn (mixed $program): array => self::object([$status, $program, $requestId], '_id'), $data);
    }

    /**
     * Enrol a customer. Enrolment dedupes on (programId, email): a repeat
     * returns the existing member with `deduped: true`, so it is safe to retry.
     *
     * @param array{programId: string, firstName: string, lastName: string, email: string, phone?: string, initialPoints?: int} $member
     * @return array<string, mixed>
     */
    public function enrollMember(array $member): array
    {
        return self::member($this->execute('POST', '/merchants/me/members', $member, retryable: true));
    }

    /**
     * Add or remove points (`delta`) or set the balance (`value`), and push
     * the wallet update. Pass one Idempotency-Key per gesture: the client
     * resends it on its own retries, and you should reuse it if you retry
     * the gesture yourself.
     *
     * @param array{delta?: int, value?: int, changeMessage?: string} $change
     * @return array<string, mixed>
     */
    public function adjustPoints(string $memberId, array $change, ?string $idempotencyKey = null): array
    {
        $response = $this->execute(
            'PATCH',
            self::memberPath($memberId) . '/points',
            $change,
            retryable: true,
            idempotencyKey: $idempotencyKey ?? self::uuidV4(),
        );
        return self::object($response);
    }

    /**
     * The member, with its program snapshot, device count and redeem count.
     *
     * @return array<string, mixed>
     */
    public function getMember(string $memberId): array
    {
        return self::member($this->execute('GET', self::memberPath($memberId)));
    }

    /**
     * Send one call and return the envelope's `data` as PHP arrays (null for
     * a 204). Only GET calls are retried by default; set $retryable only for
     * a write that cannot apply twice.
     *
     * @param array<string, mixed>|null $body
     */
    public function request(
        string $method,
        string $path,
        ?array $body = null,
        ?bool $retryable = null,
        ?string $idempotencyKey = null,
    ): mixed {
        return self::arrays($this->execute($method, $path, $body, $retryable, $idempotencyKey)[1]);
    }

    /** A random UUID (version 4), suitable as an Idempotency-Key. */
    public static function uuidV4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    /**
     * @param array<string, mixed>|null $body
     * @return array{int, mixed, ?string} status, data, request id
     */
    private function execute(
        string $method,
        string $path,
        ?array $body = null,
        ?bool $retryable = null,
        ?string $idempotencyKey = null,
    ): array {
        if (preg_match('/^[A-Z]+$/D', $method) !== 1 || preg_match('~^/[\x21-\x7E]*$~D', $path) !== 1) {
            throw new InvalidArgumentException('The method must be upper-case letters and the path must start with "/" and contain no spaces.');
        }
        if ($idempotencyKey !== null && preg_match(self::IDEMPOTENCY_KEY_PATTERN, $idempotencyKey) !== 1) {
            throw new InvalidArgumentException('An Idempotency-Key must be 8 to 128 characters of A-Z, a-z, 0-9, "_" and "-".');
        }
        $retryable ??= $method === 'GET';
        $headers = ['Accept: application/json', 'User-Agent: ' . self::USER_AGENT];
        $payload = null;
        if ($body !== null) {
            $payload = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            $headers[] = 'Content-Type: application/json';
        }
        if ($idempotencyKey !== null) {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }

        for ($attempt = 0; ; $attempt++) {
            $canRetry = $retryable && $attempt < $this->maxRetries;
            try {
                [$status, $responseHeaders, $raw] = $this->send($method, $this->baseUrl . $path, $headers, $payload);
            } catch (StowException $e) {
                // No response arrived: CONNECTION_ERROR or TIMEOUT.
                if (!$canRetry) {
                    throw $e;
                }
                $this->pause($method, $path, $attempt, self::backoffMs($attempt), $e->errorCode);
                continue;
            }

            // The status decides first; the body is read only after it.
            $requestId = isset($responseHeaders['x-correlation-id']) ? self::oneLine($responseHeaders['x-correlation-id']) : null;
            if ($status >= 300 && $status < 400) {
                $location = self::oneLine(self::firstChars(self::validUtf8($responseHeaders['location'] ?? ''), 200));
                throw new StowException(
                    $status,
                    'UNEXPECTED_REDIRECT',
                    'The API answered with a redirect' . ($location !== '' ? " to {$location}" : '')
                    . '. Redirects are not followed; check STOW_BASE_URL.',
                    [],
                    $requestId,
                );
            }
            if ($status === 204) {
                return [$status, null, $requestId];
            }
            if ($status >= 200 && $status < 300) {
                if ($raw === null) {
                    throw new StowException($status, 'UNEXPECTED_RESPONSE', 'The response body could not be decoded.', [], $requestId);
                }
                [, $decoded] = self::decode($raw);
                if (!$decoded instanceof stdClass || ($decoded->success ?? null) !== true) {
                    throw new StowException(
                        $status,
                        'UNEXPECTED_RESPONSE',
                        'The response is not a Stow Cards API response. Check that the base URL ends in /api/v1.',
                        [],
                        $requestId,
                    );
                }
                return [$status, $decoded->data ?? null, $requestId];
            }

            // An error status keeps its status rules, and its retries, even when its body cannot be decoded.
            $error = self::toException($status, $raw ?? '', $requestId);
            $retryAfterMs = self::retryAfterMs($responseHeaders['retry-after'] ?? null);
            $canRetry = $canRetry
                && self::isRetryableStatus($status, $error->errorCode, $idempotencyKey !== null, $attempt)
                && ($retryAfterMs === null || $retryAfterMs <= self::MAX_RETRY_AFTER_MS);
            if (!$canRetry) {
                throw $error;
            }
            $this->pause($method, $path, $attempt, $retryAfterMs ?? self::backoffMs($attempt), "{$status} {$error->errorCode}");
        }
    }

    /**
     * The key is added here, never passed in, so it is in no call's arguments
     * and so in no exception trace.
     *
     * @param list<string> $headers
     * @return array{int, array<string, string>, ?string} status, lower-cased response headers, body (null when it could not be decoded)
     */
    private function send(string $method, string $url, array $headers, ?string $payload): array
    {
        $responseHeaders = [];
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            // Never follow a redirect, so the key is not sent to another host.
            CURLOPT_FOLLOWLOCATION => false,
            // HTTP/1.1 on a new connection that is closed afterwards (and, below, no
            // "Expect: 100-continue"), so curl never resends a request by itself after
            // a refused HTTP/2 stream, a dropped reused connection or a 417.
            CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
            CURLOPT_FRESH_CONNECT => true,
            CURLOPT_FORBID_REUSE => true,
            // Accept every encoding curl can decode.
            CURLOPT_ENCODING => '',
            CURLOPT_CONNECTTIMEOUT => min(10, $this->timeoutSeconds),
            // Covers the whole attempt: connecting, sending and reading the body.
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$responseHeaders): int {
                if (str_starts_with($line, 'HTTP/')) {
                    $responseHeaders = [];
                } elseif (($colon = strpos($line, ':')) !== false) {
                    $responseHeaders[strtolower(trim(substr($line, 0, $colon)))] = trim(substr($line, $colon + 1));
                }
                return strlen($line);
            },
        ]);
        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, [...$headers, 'Expect:', 'X-API-Key: ' . $this->apiKey->getValue()]);

        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($raw === false) {
            // The status line and headers arrived but the body could not be decoded: the caller judges the status.
            if (curl_errno($ch) === CURLE_BAD_CONTENT_ENCODING && $status > 0) {
                return [$status, $responseHeaders, null];
            }
            throw curl_errno($ch) === CURLE_OPERATION_TIMEDOUT
                ? new StowException(0, 'TIMEOUT', "The request did not complete within {$this->timeoutSeconds} s.")
                : new StowException(0, 'CONNECTION_ERROR', 'Could not reach the API: ' . curl_error($ch));
        }

        return [$status, $responseHeaders, (string) $raw];
    }

    private function pause(string $method, string $path, int $attempt, int $delayMs, string $reason): void
    {
        if ($this->onRetry !== null) {
            ($this->onRetry)(sprintf(
                '%s %s failed (%s); retry %d of %d in %d ms',
                $method,
                $path,
                $reason,
                $attempt + 1,
                $this->maxRetries,
                $delayMs,
            ));
        }
        usleep($delayMs * 1000);
    }

    /**
     * A 409 IDEMPOTENCY_KEY_IN_USE on a retry of a keyed request means our own
     * earlier attempt still holds the key: waiting lets it finish, and the next
     * attempt receives its stored answer. On a first attempt the key belongs to
     * another request, so it is not retried, and neither is any other 409.
     */
    private static function isRetryableStatus(int $status, string $errorCode, bool $hasIdempotencyKey, int $attempt): bool
    {
        if ($status === 409) {
            return $hasIdempotencyKey && $attempt > 0 && $errorCode === 'IDEMPOTENCY_KEY_IN_USE';
        }
        return in_array($status, self::RETRYABLE_STATUSES, true);
    }

    /** Exponential backoff with full jitter. */
    private static function backoffMs(int $attempt): int
    {
        return random_int(0, min(self::MAX_BACKOFF_MS, self::INITIAL_BACKOFF_MS * 2 ** $attempt));
    }

    /** Retry-After as delay-seconds (decimals allowed) or an HTTP-date; null when absent or unparseable. */
    private static function retryAfterMs(?string $value): ?int
    {
        if ($value === null) {
            return null;
        }
        $seconds = null;
        if (preg_match(self::DELAY_SECONDS_PATTERN, $value) === 1) {
            $seconds = (float) $value;
        } else {
            $value = preg_replace('/ +/', ' ', $value) ?? $value;
            foreach (self::HTTP_DATE_FORMATS as $format) {
                $date = DateTimeImmutable::createFromFormat('!' . $format, $value, new DateTimeZone('UTC'));
                if ($date !== false && $date->format($format) === $value) {
                    $seconds = max(0.0, (float) $date->format('U') - microtime(true));
                    break;
                }
            }
        }
        // Capped while still a float, so a huge value cannot wrap into a short or negative wait.
        return $seconds === null ? null : (int) ceil(min($seconds, 86_400.0) * 1000);
    }

    /**
     * The JSON body, with objects as stdClass so that an object can be told
     * from a list (`{}` and `[]` would both be an empty array).
     *
     * @return array{bool, mixed} whether the body is JSON, and its value
     */
    private static function decode(string $raw): array
    {
        try {
            return [true, json_decode($raw, false, 512, JSON_THROW_ON_ERROR)];
        } catch (JsonException) {
            return [false, null];
        }
    }

    /** Decoded JSON as plain PHP values, objects becoming associative arrays. */
    private static function arrays(mixed $value): mixed
    {
        if ($value instanceof stdClass) {
            $value = get_object_vars($value);
        }
        return is_array($value) ? array_map(self::arrays(...), $value) : $value;
    }

    private static function toException(int $status, string $raw, ?string $requestId): StowException
    {
        [$isJson, $body] = self::decode($raw);
        $error = [];
        if ($body instanceof stdClass && ($body->error ?? null) instanceof stdClass) {
            $error = self::arrays($body->error);
        } elseif ($body instanceof stdClass && is_string($body->error ?? null)) {
            // The flat {"error": message, "code": ...} that older gateways sent.
            $error = ['message' => $body->error] + array_diff_key(self::arrays($body), ['error' => 0, 'success' => 0, 'message' => 0]);
        }
        $code = is_string($error['code'] ?? null) && self::trimSpace($error['code']) !== '' ? $error['code'] : "HTTP_{$status}";
        // A body that is not JSON (a proxy's error page, say) or is a bare JSON string: its first 500 characters.
        $text = $isJson ? (is_string($body) ? self::trimSpace($body) : '') : self::trimSpace(self::validUtf8($raw));
        if (is_string($error['message'] ?? null) && self::trimSpace($error['message']) !== '') {
            $message = $error['message'];
        } elseif ($text !== '') {
            $message = self::firstChars($text, 500);
        } else {
            $message = "Request failed with status {$status}";
        }
        unset($error['code'], $error['message']);

        return new StowException($status, $code, self::oneLine($message), $error, $requestId);
    }

    /**
     * A JSON object (never a list, not even an empty one) whose named fields
     * are non-empty strings, as an associative array.
     *
     * @param array{int, mixed, ?string} $response
     * @return array<string, mixed>
     */
    private static function object(array $response, string ...$requiredStrings): array
    {
        [$status, $data, $requestId] = $response;
        if (!$data instanceof stdClass) {
            throw self::unexpectedShape($status, $requestId);
        }
        $data = self::arrays($data);
        foreach ($requiredStrings as $field) {
            if (!is_string($data[$field] ?? null) || $data[$field] === '') {
                throw self::unexpectedShape($status, $requestId);
            }
        }
        return $data;
    }

    /**
     * A member object whose `id` memberPath() accepts, so the flow never
     * fails later on an id the API sent.
     *
     * @param array{int, mixed, ?string} $response
     * @return array<string, mixed>
     */
    private static function member(array $response): array
    {
        $member = self::object($response);
        if (!is_string($member['id'] ?? null) || !self::isMemberId($member['id'])) {
            throw self::unexpectedShape($response[0], $response[2]);
        }
        return $member;
    }

    private static function memberPath(string $memberId): string
    {
        if (!self::isMemberId($memberId)) {
            throw new InvalidArgumentException('A member id is required (not blank, "." or "..").');
        }
        return '/merchants/me/members/' . rawurlencode($memberId);
    }

    /** Not blank, and not "." or "..", which curl would resolve into another endpoint. */
    private static function isMemberId(string $memberId): bool
    {
        return self::trimSpace($memberId) !== '' && $memberId !== '.' && $memberId !== '..';
    }

    /** $text without surrounding whitespace (self::SPACE). It may hold the key. */
    private static function trimSpace(#[\SensitiveParameter] string $text): string
    {
        // Not valid UTF-8: only ASCII whitespace can be trimmed.
        return preg_replace('/^' . self::SPACE . '+|' . self::SPACE . '+$/uD', '', $text) ?? trim($text, " \t\n\v\f\r");
    }

    private static function unexpectedShape(int $status, ?string $requestId): StowException
    {
        return new StowException($status, 'UNEXPECTED_RESPONSE', 'The response data does not have the expected shape.', [], $requestId);
    }

    /** $text on one line: every run of Unicode spaces and line breaks (U+0085, U+2028 and U+2029 too) becomes one space. */
    private static function oneLine(string $text): string
    {
        return trim(preg_replace('/(?:' . self::SPACE . '|[\x{1C}-\x{1F}\x{85}])+/u', ' ', self::validUtf8($text)) ?? '', ' ');
    }

    /** $text with each invalid UTF-8 sequence replaced by U+FFFD, so the /u patterns always apply. */
    private static function validUtf8(string $text): string
    {
        return json_decode(json_encode($text, JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR), false, 512, JSON_THROW_ON_ERROR);
    }

    /** The first $max characters of valid UTF-8 $text. */
    private static function firstChars(string $text, int $max): string
    {
        return preg_match('/^.{0,' . $max . '}/su', $text, $match) === 1 ? $match[0] : '';
    }

    private static function normaliseBaseUrl(string $baseUrl): string
    {
        $invalid = 'The base URL (STOW_BASE_URL) is not a valid URL, for example ' . self::DEFAULT_BASE_URL . '.';
        $baseUrl = trim($baseUrl);
        if (preg_match('~^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)(.*)$~sD', $baseUrl, $m) !== 1) {
            throw new InvalidArgumentException($invalid);
        }
        [, $scheme, $authority, $rest] = $m;
        $scheme = strtolower($scheme);
        if (str_contains($authority, '@') || str_contains($rest, '?') || str_contains($rest, '#')) {
            throw new InvalidArgumentException('The base URL (STOW_BASE_URL) must not contain credentials, a query string or a fragment.');
        }
        if (preg_match('/^(\[[^\]]*\]|[^:]*)(?::(.*))?$/sD', $authority, $a) !== 1 || preg_match('/^[\x21-\x7E]*$/D', $rest) !== 1) {
            throw new InvalidArgumentException($invalid);
        }
        $host = strtolower($a[1]);
        $validHost = str_starts_with($host, '[')
            ? filter_var(substr($host, 1, -1), FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false
            : preg_match(self::HOST_NAME_PATTERN, $host) === 1;
        if (!$validHost) {
            throw new InvalidArgumentException($invalid);
        }
        if (isset($a[2]) && (preg_match('/^\d{1,5}$/D', $a[2]) !== 1 || (int) $a[2] < 1 || (int) $a[2] > 65535)) {
            throw new InvalidArgumentException('The base URL (STOW_BASE_URL) has an invalid port.');
        }
        $plainHttpAllowed = $scheme === 'http'
            && (in_array($host, self::PLAIN_HTTP_HOSTS, true) || str_ends_with($host, '.localhost'));
        if ($scheme !== 'https' && !$plainHttpAllowed) {
            throw new InvalidArgumentException(
                'The base URL (STOW_BASE_URL) must use https, so the API key is never sent unencrypted. '
                . 'Plain http is accepted only for localhost, 127.0.0.1, [::1], names ending in .localhost and host.docker.internal.'
            );
        }

        return rtrim($baseUrl, '/');
    }
}
