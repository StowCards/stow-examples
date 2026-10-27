// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP transport: authentication, timeouts, cancellation, retries and
 * envelope unwrapping. Every API method goes through {@link Transport.request}.
 */
import { randomUUID } from 'node:crypto';
import { ApiPromise, type RateLimitInfo, type ResponseMeta, type WithResponse } from './api-promise.js';
import {
  StowAbortError,
  StowApiError,
  StowConnectionError,
  StowTimeoutError,
  createApiError,
  isRecord,
} from './errors.js';
import type { LevelLogger } from './logger.js';
import { type PageData, PagePromise } from './pagination.js';
import { MAX_RETRY_AFTER_MS, backoffDelayMs, retryAfterMs, shouldRetry } from './retry.js';

/** Options accepted by every API method, overriding the client defaults for one call. */
export interface RequestOptions {
  /** Cancel the call. Aborting rejects with a {@link StowAbortError}. */
  signal?: AbortSignal | undefined;
  /** Per-attempt timeout in milliseconds, an integer from 1 to 2147483647. */
  timeout?: number | undefined;
  /**
   * Retries after the first attempt. `0` disables retries for this call.
   * A pass push is never retried, whatever this says.
   */
  maxRetries?: number | undefined;
  /** Extra request headers. */
  headers?: Record<string, string> | undefined;
}

/**
 * Options for calls that change a balance or status. These always carry an
 * `Idempotency-Key`, so automatic retries can never apply the change twice.
 */
export interface IdempotentRequestOptions extends RequestOptions {
  /**
   * Your key for this logical gesture, 8 to 128 characters of
   * `[A-Za-z0-9_-]`. Pass the same key when you retry the gesture yourself
   * (for example after a crash), and a new key for every new gesture. When
   * omitted, the SDK generates a UUID and reuses it across its own retries.
   */
  idempotencyKey?: string | undefined;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** @internal */
export type QueryValue = string | number | boolean | null | undefined | readonly string[];

/** @internal */
export interface RequestSpec {
  method: HttpMethod;
  /** Path below the base URL, starting with `/`, segments already encoded. */
  path: string;
  query?: Record<string, QueryValue> | undefined;
  /** JSON body. */
  body?: unknown;
  /** Multipart body; takes precedence over `body`. */
  form?: FormData | undefined;
  /** Whether repeating the request cannot apply it twice. */
  idempotent: boolean;
  /**
   * Make exactly one attempt, even on a 429 and whatever `maxRetries` says:
   * for calls whose every attempt the customer can see.
   */
  neverRetry?: boolean | undefined;
  idempotencyKey?: string | undefined;
  options?: RequestOptions | undefined;
}

/** @internal */
export interface TransportConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  fetch: typeof fetch;
  defaultHeaders: Record<string, string>;
  userAgent: string;
  logger: LevelLogger;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** @internal */
export class Transport {
  readonly #config: TransportConfig;

  constructor(config: TransportConfig) {
    this.#config = config;
  }

  /**
   * Send one request. The spec is built inside the returned promise, so an
   * invalid argument rejects it rather than throwing synchronously.
   */
  request<T>(build: () => RequestSpec): ApiPromise<T> {
    return ApiPromise._create(this.#run<T>(build));
  }

  /** Send a paginated list request, starting at `firstPage`. */
  list<T>(build: (page: number) => RequestSpec, firstPage: number | undefined): PagePromise<T> {
    return PagePromise._create<T>(async (page) => {
      const result = await this.#run<PageData<T>>(() => build(page));
      if (!isRecord(result.data) || !Array.isArray(result.data.items)) {
        throw unexpectedBody(
          result.response.status,
          result.data,
          result.response.headers,
          result.response.requestId,
        );
      }
      return result;
    }, firstPage ?? 1);
  }

  async #run<T>(build: () => RequestSpec): Promise<WithResponse<T>> {
    return this.#execute<T>(build());
  }

  /** Resolve an idempotency key: validate the caller's, or mint one. */
  static idempotencyKey(options: IdempotentRequestOptions | undefined): string {
    const key = options?.idempotencyKey;
    if (key === undefined) return randomUUID();
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new TypeError('idempotencyKey must be 8 to 128 characters of [A-Za-z0-9_-].');
    }
    return key;
  }

  async #execute<T>(spec: RequestSpec): Promise<WithResponse<T>> {
    const options = spec.options ?? {};
    const requestedRetries = options.maxRetries ?? this.#config.maxRetries;
    const timeout = options.timeout ?? this.#config.timeout;
    assertNonNegativeInteger('maxRetries', requestedRetries);
    assertTimeoutMs('timeout', timeout);
    const maxRetries = spec.neverRetry === true ? 0 : requestedRetries;

    const { signal } = options;
    if (signal?.aborted) throw abortError(signal);

    const url = this.#buildUrl(spec.path, spec.query);
    const correlationId = randomUUID();
    const headers = this.#buildHeaders(spec, correlationId);
    const body = spec.form ?? (spec.body === undefined ? undefined : JSON.stringify(spec.body));
    const hasIdempotencyKey = spec.idempotencyKey !== undefined;
    const label = `${spec.method} ${spec.path}`;

    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      this.#config.logger.debug(`${label} attempt ${String(attempt + 1)} (request ${correlationId})`);

      let response: Response;
      let text: string;
      try {
        ({ response, text } = await this.#send(url, spec.method, headers, body, timeout, signal));
      } catch (error) {
        if (error instanceof StowAbortError) throw error;
        if (attempt < maxRetries && shouldRetry(undefined, spec.idempotent, hasIdempotencyKey, attempt)) {
          const delay = backoffDelayMs(attempt);
          this.#config.logger.info(
            `${label} failed (${(error as Error).message}); retry ${String(attempt + 1)}/${String(maxRetries)} in ${String(delay)} ms`,
          );
          await sleep(delay, signal);
          continue;
        }
        throw error;
      }

      const requestId = response.headers.get('x-correlation-id') ?? correlationId;
      const parsed = parseBody(text, response.headers);
      this.#config.logger.debug(
        `${label} -> ${String(response.status)} in ${String(Date.now() - startedAt)} ms (request ${requestId})`,
      );

      if (response.ok && !(isRecord(parsed) && parsed['success'] === false)) {
        // Anything but 204 must be the API's envelope. A body that is not (an
        // HTML page from a proxy or a wrong baseUrl, say) is an error, not data.
        if (response.status !== 204 && !(isRecord(parsed) && parsed['success'] === true)) {
          throw unexpectedBody(response.status, parsed, response.headers, requestId);
        }
        const meta: ResponseMeta = {
          status: response.status,
          headers: response.headers,
          requestId,
          idempotencyReplayed: response.headers.get('idempotency-replayed') === 'true',
          idempotencyKey: spec.idempotencyKey,
          rateLimit: readRateLimit(response.headers),
          attempts: attempt + 1,
        };
        return { data: unwrap(parsed) as T, response: meta };
      }

      const wait = retryAfterMs(response.headers, response.status === 429);
      const error = createApiError(response.status, parsed, response.headers, requestId, wait);
      const retryable =
        attempt < maxRetries &&
        shouldRetry(response.status, spec.idempotent, hasIdempotencyKey, attempt, error.code) &&
        (wait === undefined || wait <= MAX_RETRY_AFTER_MS);
      if (!retryable) throw error;

      const delay = wait ?? backoffDelayMs(attempt);
      this.#config.logger.info(
        `${label} -> ${String(response.status)} ${error.code}; retry ${String(attempt + 1)}/${String(maxRetries)} in ${String(delay)} ms (request ${requestId})`,
      );
      await sleep(delay, signal);
    }
  }

  async #send(
    url: string,
    method: HttpMethod,
    headers: Headers,
    body: string | FormData | undefined,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; text: string }> {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      // Redirects are refused, so the API key is never forwarded to another host.
      const response = await this.#config.fetch(url, {
        method,
        headers,
        body: body ?? null,
        signal: combined,
        redirect: 'error',
      });
      // Read the body inside the try block so the timeout also covers it.
      const text = await response.text();
      return { response, text };
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (timeoutSignal.aborted) {
        throw new StowTimeoutError(`Request timed out after ${String(timeout)} ms.`, { cause: error });
      }
      throw new StowConnectionError(`Connection error: ${describe(error)}`, { cause: error });
    }
  }

  #buildUrl(path: string, query: Record<string, QueryValue> | undefined): string {
    const url = new URL(this.#config.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value as readonly string[]) url.searchParams.append(key, item);
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  #buildHeaders(spec: RequestSpec, correlationId: string): Headers {
    const headers = new Headers({
      Accept: 'application/json',
      'User-Agent': this.#config.userAgent,
      'X-Correlation-Id': correlationId,
    });
    for (const [name, value] of Object.entries(this.#config.defaultHeaders)) headers.set(name, value);
    for (const [name, value] of Object.entries(spec.options?.headers ?? {})) headers.set(name, value);
    // Set last, so these always match what the SDK tracks.
    headers.set('X-API-Key', this.#config.apiKey);
    if (spec.form === undefined && spec.body !== undefined) headers.set('Content-Type', 'application/json');
    if (spec.idempotencyKey !== undefined) headers.set('Idempotency-Key', spec.idempotencyKey);
    return headers;
  }
}

function parseBody(text: string, headers: Headers): unknown {
  if (text === '') return undefined;
  const contentType = headers.get('content-type') ?? '';
  const looksJson = contentType.includes('json') || /^\s*[{[]/.test(text);
  if (!looksJson) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function unwrap(body: unknown): unknown {
  return isRecord(body) ? body['data'] : undefined;
}

/** A 2xx answer whose body is not the API's success envelope. */
function unexpectedBody(
  status: number,
  body: unknown,
  headers: Headers,
  requestId: string | undefined,
): StowApiError {
  return new StowApiError({
    status,
    code: 'UNEXPECTED_RESPONSE',
    message:
      'The response is not a Stow Cards API response. Check that baseUrl points at the API ' +
      '(including /api/v1) and that no proxy rewrites the answer.',
    requestId,
    headers,
    body,
  });
}

function readRateLimit(headers: Headers): RateLimitInfo {
  return {
    limit: toNumber(headers.get('ratelimit-limit')),
    remaining: toNumber(headers.get('ratelimit-remaining')),
    resetSeconds: toNumber(headers.get('ratelimit-reset')),
  };
}

function toNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function abortError(signal: AbortSignal): StowAbortError {
  return new StowAbortError('The request was aborted.', { cause: signal.reason });
}

/** @internal Wait `ms`, rejecting with a {@link StowAbortError} as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
}

/** The longest delay `setTimeout` honours; a larger one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** @internal Require a whole number of milliseconds a timer can wait for. */
export function assertTimeoutMs(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new TypeError(
      `${name} must be an integer number of milliseconds from 1 to ${String(MAX_TIMER_MS)}.`,
    );
  }
}
