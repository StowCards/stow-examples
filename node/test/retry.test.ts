// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { ApiPromise } from '../src/index.js';
import { LevelLogger } from '../src/core/logger.js';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  backoffDelayMs,
  retryAfterMs,
  shouldRetry,
} from '../src/core/retry.js';

describe('retryAfterMs', () => {
  const now = Date.parse('2026-10-13T12:00:00.000Z');

  it.each([
    [{ 'retry-after': '3' }, false, 3_000],
    [{ 'retry-after': '1.5' }, true, 1_500],
    [{ 'retry-after': 'Tue, 13 Oct 2026 12:00:10 GMT' }, false, 10_000],
    [{ 'retry-after': 'Tue, 13 Oct 2026 11:59:00 GMT' }, false, 0],
    [{ 'ratelimit-reset': '42' }, true, 42_000],
    [{ 'retry-after': 'soon', 'ratelimit-reset': '7' }, true, 7_000],
    [{ 'retry-after': '', 'ratelimit-reset': '' }, true, undefined],
    [{ 'ratelimit-reset': '-1' }, true, undefined],
    [{}, true, undefined],
  ])('reads %j (rate limited: %s)', (headers, rateLimited, expected) => {
    expect(retryAfterMs(new Headers(headers), rateLimited, now)).toBe(expected);
  });

  it('ignores RateLimit-Reset on a response that was not rate limited', () => {
    // The gateway sends it on every response; on a 503 it says nothing about retrying.
    expect(retryAfterMs(new Headers({ 'ratelimit-reset': '900' }), false, now)).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with full jitter and a ceiling', () => {
    expect(backoffDelayMs(0, () => 0.999)).toBe(INITIAL_RETRY_DELAY_MS - 1);
    expect(backoffDelayMs(2, () => 0.5)).toBe(INITIAL_RETRY_DELAY_MS * 2);
    expect(backoffDelayMs(20, () => 0.999)).toBeLessThan(MAX_RETRY_DELAY_MS);
    expect(backoffDelayMs(3, () => 0)).toBe(0);
  });
});

describe('shouldRetry', () => {
  it.each([
    [undefined, true, false, 0, undefined, true],
    [undefined, false, false, 0, undefined, false],
    [429, false, false, 0, 'HTTP_429', true],
    [409, true, true, 0, 'IDEMPOTENCY_KEY_IN_USE', false],
    [409, true, true, 1, 'IDEMPOTENCY_KEY_IN_USE', true],
    [409, true, false, 1, 'IDEMPOTENCY_KEY_IN_USE', false],
    [409, true, true, 1, 'CONFLICT', false],
    [409, true, true, 1, 'REDEEM_NOT_ELIGIBLE', false],
    [409, true, true, 1, 'STAMP_CARD_FULL', false],
    [503, true, false, 0, 'SERVICE_UNAVAILABLE', true],
    [503, false, false, 0, 'SERVICE_UNAVAILABLE', false],
    [501, true, false, 0, 'INTERNAL_ERROR', false],
    [404, true, false, 0, 'NOT_FOUND', false],
  ])(
    'status %s idempotent=%s keyed=%s attempt=%s code=%s -> %s',
    (status, idempotent, keyed, attempt, code, expected) => {
      expect(shouldRetry(status, idempotent, keyed, attempt, code)).toBe(expected);
    },
  );
});

describe('LevelLogger', () => {
  it('filters by level and prefixes lines', () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = new LevelLogger(sink, 'warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledWith('[stow] c');

    const silent = new LevelLogger(sink, 'off');
    silent.warn('d');
    expect(sink.warn).toHaveBeenCalledTimes(1);
  });
});

describe('ApiPromise', () => {
  it('identifies itself', () => {
    const promise = ApiPromise._create(Promise.resolve({ data: 1, response: {} as never }));
    expect(Object.prototype.toString.call(promise)).toBe('[object ApiPromise]');
  });
});
