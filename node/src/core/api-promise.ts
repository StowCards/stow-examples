// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Response metadata and the promise type every API method returns.
 */

/** Rate-limit state reported by the gateway on the response. */
export interface RateLimitInfo {
  /** Requests allowed in the current window (`RateLimit-Limit`). */
  limit: number | undefined;
  /** Requests left in the current window (`RateLimit-Remaining`). */
  remaining: number | undefined;
  /** Seconds until the window resets (`RateLimit-Reset`). */
  resetSeconds: number | undefined;
}

/** What the SDK knows about the HTTP exchange behind a result. */
export interface ResponseMeta {
  /** HTTP status of the final attempt. */
  status: number;
  /** Response headers of the final attempt. */
  headers: Headers;
  /** Correlation id (`X-Correlation-Id`); quote it when contacting support. */
  requestId: string | undefined;
  /**
   * `true` when the API replayed a stored response for a repeated
   * `Idempotency-Key` instead of applying the change again.
   */
  idempotencyReplayed: boolean;
  /** The `Idempotency-Key` sent with the request, when there was one. */
  idempotencyKey: string | undefined;
  /** Rate-limit state after this request. */
  rateLimit: RateLimitInfo;
  /** How many HTTP attempts the call took (1 when no retry was needed). */
  attempts: number;
}

/** A result together with the metadata of the response that produced it. */
export interface WithResponse<T> {
  data: T;
  response: ResponseMeta;
}

/**
 * The promise returned by every API method.
 *
 * Await it for the data. Call {@link ApiPromise.withResponse} instead when
 * you also need the request id, rate-limit state or idempotency outcome.
 *
 * @example
 * ```ts
 * const member = await stow.members.get(id);
 * const { data, response } = await stow.members.get(id).withResponse();
 * console.log(response.requestId, response.rateLimit.remaining);
 * ```
 */
export class ApiPromise<T> implements PromiseLike<T> {
  readonly #result: Promise<WithResponse<T>>;

  // Private, so the declarations publish no constructor: the SDK creates these.
  private constructor(result: Promise<WithResponse<T>>) {
    this.#result = result;
  }

  /** @internal */
  static _create<T>(result: Promise<WithResponse<T>>): ApiPromise<T> {
    return new ApiPromise(result);
  }

  /** Resolve with the data and the response metadata. */
  withResponse(): Promise<WithResponse<T>> {
    return this.#result;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#result.then((result) => result.data).then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.then(undefined, onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.then().finally(onfinally);
  }

  readonly [Symbol.toStringTag] = 'ApiPromise';
}
