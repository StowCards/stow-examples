// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Error hierarchy.
 *
 * Every error the SDK throws extends {@link StowError}, so one `instanceof`
 * check separates SDK failures from bugs in your own code. API failures are a
 * {@link StowApiError} subclass chosen by HTTP status; transport failures are
 * {@link StowConnectionError} (or {@link StowTimeoutError}); a cancelled call
 * is a {@link StowAbortError}.
 */

/** Base class of every error thrown by the SDK. */
export class StowError extends Error {
  override readonly name: string = 'StowError';
}

/** Fields shared by every API error. */
export interface StowApiErrorInit {
  /** HTTP status code. */
  status: number;
  /** Stable, machine-readable error code from the API, e.g. `REDEEM_NOT_ELIGIBLE`. */
  code: string;
  /** Human-readable message from the API (localised by the server). */
  message: string;
  /** Correlation id of the failed request, for support tickets. */
  requestId: string | undefined;
  /** Response headers. */
  headers: Headers;
  /** The parsed response body (JSON object or text). */
  body: unknown;
}

/**
 * The API answered with a non-success status.
 *
 * Branch on {@link StowApiError.code} for programmatic handling; show
 * `message` to people. Quote
 * {@link StowApiError.requestId} when contacting support.
 */
export class StowApiError extends StowError {
  override readonly name: string = 'StowApiError';
  /** HTTP status code. */
  readonly status: number;
  /** Stable, machine-readable error code, e.g. `NOT_FOUND` or `STAMP_CARD_FULL`. */
  readonly code: string;
  /** Correlation id of the failed request (`X-Correlation-Id`). */
  readonly requestId: string | undefined;
  /** Response headers. */
  readonly headers: Headers;
  /** The parsed response body (JSON object or text). */
  readonly body: unknown;
  /**
   * Extra fields the API put on the error object besides `code` and
   * `message`, for example `current` and `goal` on `REDEEM_NOT_ELIGIBLE`.
   */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(init: StowApiErrorInit) {
    super(`${String(init.status)} ${init.code}: ${init.message}`);
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.headers = init.headers;
    this.body = init.body;
    this.details = extractDetails(init.body);
  }
}

/** 400: the request was malformed or failed validation. */
export class BadRequestError extends StowApiError {
  override readonly name: string = 'BadRequestError';
}

/** 401: the API key is missing, invalid, expired or revoked. */
export class AuthenticationError extends StowApiError {
  override readonly name: string = 'AuthenticationError';
}

/**
 * 402: the merchant's Stow Cards subscription is not active
 * (`BILLING_SUBSCRIPTION_REQUIRED`). Sign in to the web console to renew it.
 */
export class PaymentRequiredError extends StowApiError {
  override readonly name: string = 'PaymentRequiredError';
}

/** 403: the API key is valid but its roles lack the required permission. */
export class PermissionDeniedError extends StowApiError {
  override readonly name: string = 'PermissionDeniedError';
}

/** 404: the resource does not exist within your merchant. */
export class NotFoundError extends StowApiError {
  override readonly name: string = 'NotFoundError';
}

/**
 * 409: the member's state refuses the change (not active, stamp card full,
 * reward not reached yet), or, with `code` `IDEMPOTENCY_KEY_IN_USE`, an
 * earlier request with the same `Idempotency-Key` is still being processed.
 * The SDK waits and retries that code itself on its own retries; you see it
 * when a key you passed is still in use by another call, so retry the same
 * request with the same key shortly to get its answer.
 */
export class ConflictError extends StowApiError {
  override readonly name: string = 'ConflictError';
}

/** 422: the request was well formed but semantically invalid. */
export class UnprocessableEntityError extends StowApiError {
  override readonly name: string = 'UnprocessableEntityError';
}

/** 429: the rate limit was exceeded (`code` `RATE_LIMITED`). */
export class RateLimitError extends StowApiError {
  override readonly name: string = 'RateLimitError';
  /**
   * How long the server asked you to wait before retrying, in milliseconds,
   * when it said so (`Retry-After` or `RateLimit-Reset`).
   */
  readonly retryAfterMs: number | undefined;

  constructor(init: StowApiErrorInit & { retryAfterMs: number | undefined }) {
    super(init);
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** 5xx: the API failed. Idempotent calls are retried automatically first. */
export class InternalServerError extends StowApiError {
  override readonly name: string = 'InternalServerError';
}

/** The request never produced an HTTP response (DNS, TLS, reset socket, …). */
export class StowConnectionError extends StowError {
  override readonly name: string = 'StowConnectionError';
}

/** The request did not finish within the configured timeout. */
export class StowTimeoutError extends StowConnectionError {
  override readonly name: string = 'StowTimeoutError';
}

/** The call was cancelled through the `signal` you passed. */
export class StowAbortError extends StowError {
  override readonly name: string = 'StowAbortError';
}

/** A webhook delivery failed signature verification. Reject it with a 4xx. */
export class WebhookVerificationError extends StowError {
  override readonly name: string = 'WebhookVerificationError';
}

/** Build the right {@link StowApiError} subclass for a failed response. */
export function createApiError(
  status: number,
  body: unknown,
  headers: Headers,
  requestId: string | undefined,
  retryAfterMs: number | undefined,
): StowApiError {
  const { code, message } = readErrorFields(status, body);
  const init: StowApiErrorInit = { status, code, message, requestId, headers, body };
  switch (status) {
    case 400:
      return new BadRequestError(init);
    case 401:
      return new AuthenticationError(init);
    case 402:
      return new PaymentRequiredError(init);
    case 403:
      return new PermissionDeniedError(init);
    case 404:
      return new NotFoundError(init);
    case 409:
      return new ConflictError(init);
    case 422:
      return new UnprocessableEntityError(init);
    case 429:
      return new RateLimitError({ ...init, retryAfterMs });
    default:
      return status >= 500 ? new InternalServerError(init) : new StowApiError(init);
  }
}

/**
 * The error fields of a response body: the documented envelope
 * `{ success: false, error: { code, message, … } }`, or the flat
 * `{ error: message, code }` that gateways before API version 1.0.6 used for
 * authentication failures.
 */
function errorObject(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const error = body['error'];
  if (isRecord(error)) return error;
  if (typeof error === 'string') {
    const fields = Object.entries(body).filter(([key]) => key !== 'error' && key !== 'success');
    return { ...Object.fromEntries(fields), message: error };
  }
  return undefined;
}

function readErrorFields(status: number, body: unknown): { code: string; message: string } {
  const error = errorObject(body);
  const code = typeof error?.['code'] === 'string' ? error['code'] : `HTTP_${String(status)}`;
  let message: string;
  if (typeof error?.['message'] === 'string') {
    message = error['message'];
  } else if (typeof body === 'string' && body.trim() !== '') {
    // Gateways before API version 1.0.14 answered a 429 in plain text.
    message = body.trim().slice(0, 500);
  } else {
    message = `Request failed with status ${String(status)}`;
  }
  return { code, message };
}

function extractDetails(body: unknown): Readonly<Record<string, unknown>> {
  const error = errorObject(body);
  if (!error) return Object.freeze({});
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key !== 'code' && key !== 'message') details[key] = value;
  }
  return Object.freeze(details);
}

/** @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
