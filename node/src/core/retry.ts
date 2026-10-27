// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry policy: which failures are retried, and how long to wait.
 *
 * Waits use exponential backoff with full jitter (the AWS Architecture Blog
 * and Google Cloud recommendation), and honour the server's `Retry-After` /
 * `RateLimit-Reset` when it sends one.
 */

/** First backoff ceiling, in milliseconds. */
export const INITIAL_RETRY_DELAY_MS = 500;
/** Largest computed backoff, in milliseconds. */
export const MAX_RETRY_DELAY_MS = 8_000;
/**
 * The longest server-requested wait the SDK will sleep through. A longer
 * `Retry-After` (the gateway's window is 15 minutes) is surfaced to the caller
 * as a {@link RateLimitError} straight away rather than blocking the call.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Statuses worth retrying when the request is safe to repeat. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Whether a failed attempt should be retried.
 *
 * @param status - HTTP status, or `undefined` for a transport failure.
 * @param idempotent - Whether repeating the request cannot apply it twice.
 * @param hasIdempotencyKey - Whether the request carried an `Idempotency-Key`.
 * @param attempt - Zero-based number of the attempt that just failed.
 * @param code - The API error code, when the response carried one.
 * @internal
 */
export function shouldRetry(
  status: number | undefined,
  idempotent: boolean,
  hasIdempotencyKey: boolean,
  attempt: number,
  code?: string,
): boolean {
  if (status === undefined) return idempotent;
  // A 429 means the request was not processed, so it is safe to repeat.
  // (A pass push never gets here: it is sent with `neverRetry`, because the
  // SDK cannot rule out a 429 produced after the push went out.)
  if (status === 429) return true;
  // On a retry of a keyed request, `IDEMPOTENCY_KEY_IN_USE` means the earlier
  // attempt (which we stopped waiting for) still holds the key: waiting lets
  // it finish, and the next attempt receives the stored response. Every other
  // 409 is a refusal and is never retried: `CONFLICT` (member not active,
  // status changed by another request) would let a repeat overwrite the other
  // change, and some business refusals (`REDEEM_NOT_ELIGIBLE`,
  // `STAMP_CARD_FULL`, …) notify the customer each time. Nor is any 409 on a
  // first attempt, since only our own earlier attempt can hold the key.
  if (status === 409) {
    return hasIdempotencyKey && attempt > 0 && code === 'IDEMPOTENCY_KEY_IN_USE';
  }
  return idempotent && RETRYABLE_STATUSES.has(status);
}

/**
 * Exponential backoff with full jitter.
 *
 * @param attempt - Zero-based number of the attempt that just failed.
 * @internal
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * The wait the server asked for, in milliseconds, from `Retry-After`
 * (seconds or an HTTP date) or, on a rate-limited response only,
 * `RateLimit-Reset` (seconds). The gateway sends `RateLimit-Reset` on every
 * response, so for any other status it says nothing about when to retry.
 *
 * @param rateLimited - Whether the response was a 429.
 * @internal
 */
export function retryAfterMs(
  headers: Headers,
  rateLimited: boolean,
  now: number = Date.now(),
): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = rateLimited ? headers.get('ratelimit-reset') : null;
  if (reset !== null) {
    const seconds = Number(reset);
    if (reset.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  return undefined;
}
