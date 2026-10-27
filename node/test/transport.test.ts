// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  StowAbortError,
  StowApiError,
  StowConnectionError,
  StowError,
  StowTimeoutError,
  UnprocessableEntityError,
} from '../src/index.js';
import { API_KEY, connectionRefused, fail, json, makeClient, mockFetch, ok } from './helpers.js';

const MEMBER_ID = '665c1f00-0000-0000-0000-000000000000';

beforeEach(() => {
  // Zero jitter: retries back off for 0 ms so tests run instantly.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('requests', () => {
  it('authenticates with X-API-Key and identifies the SDK', async () => {
    const { fetch, calls } = mockFetch(ok([]));
    await makeClient(fetch, {
      appInfo: { name: 'acme-pos', version: '4.2.0', url: 'https://acme.test' },
    }).programs.list();

    const headers = calls[0]?.headers;
    expect(headers?.get('x-api-key')).toBe(API_KEY);
    expect(headers?.get('authorization')).toBeNull();
    expect(headers?.get('accept')).toBe('application/json');
    expect(headers?.get('user-agent')).toMatch(
      /^stowcards-node\/\d+\.\d+\.\d+ node\/v\d+\S* \(\w+; \w+\) acme-pos\/4\.2\.0 \(\+https:\/\/acme\.test\)$/,
    );
    expect(headers?.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('merges default and per-request headers but keeps the API key', async () => {
    const { fetch, calls } = mockFetch(ok([]));
    const client = makeClient(fetch, { defaultHeaders: { 'X-Team': 'loyalty', 'Accept-Language': 'en' } });
    await client.programs.list({ headers: { 'Accept-Language': 'tr', 'X-API-Key': 'other' } });

    const headers = calls[0]?.headers;
    expect(headers?.get('x-team')).toBe('loyalty');
    expect(headers?.get('accept-language')).toBe('tr');
    expect(headers?.get('x-api-key')).toBe(API_KEY);
  });

  it('unwraps the envelope and reports response metadata', async () => {
    const { fetch } = mockFetch(
      ok({ id: MEMBER_ID }, 200, {
        'x-correlation-id': 'req-123',
        'ratelimit-limit': '1000',
        'ratelimit-remaining': '998',
        'ratelimit-reset': '840',
      }),
    );
    const { data, response } = await makeClient(fetch).members.get(MEMBER_ID).withResponse();

    expect(data).toEqual({ id: MEMBER_ID });
    expect(response).toMatchObject({
      status: 200,
      requestId: 'req-123',
      idempotencyReplayed: false,
      idempotencyKey: undefined,
      attempts: 1,
      rateLimit: { limit: 1000, remaining: 998, resetSeconds: 840 },
    });
  });

  it('falls back to its own correlation id when the response has none', async () => {
    const { fetch, calls } = mockFetch(ok({}));
    const { response } = await makeClient(fetch).members.get(MEMBER_ID).withResponse();
    expect(response.requestId).toBe(calls[0]?.headers.get('x-correlation-id'));
  });

  it.each([
    [
      'an HTML page',
      new Response('<html>Welcome</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
    ['an empty body', new Response('', { status: 200 })],
    ['JSON that is not an envelope', json(200, { id: 'm1' })],
    ['a JSON array', json(200, [])],
  ])('raises a StowApiError for a 2xx with %s', async (_label, reply) => {
    const { fetch, calls } = mockFetch(reply);
    const error = await makeClient(fetch)
      .members.get(MEMBER_ID)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StowApiError);
    expect(error).toMatchObject({ status: 200, code: 'UNEXPECTED_RESPONSE' });
    expect((error as StowApiError).requestId).toBe(calls[0]?.headers.get('x-correlation-id'));
    expect(calls).toHaveLength(1);
  });

  it('raises a StowApiError for a list whose data has no items array', async () => {
    const { fetch } = mockFetch(ok([{ id: 'm1' }], 200, { 'x-correlation-id': 'req_list' }));
    const error = await makeClient(fetch)
      .members.list()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(StowApiError);
    expect(error).toMatchObject({ status: 200, code: 'UNEXPECTED_RESPONSE', requestId: 'req_list' });
  });

  it('resolves 204 No Content with undefined', async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 204 }));
    await expect(makeClient(fetch).webhooks.delete('sub_1')).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('refuses redirects so the key never reaches another host', async () => {
    const { fetch } = mockFetch((call) => {
      expect(call.url.href).toContain('/merchants/me/programs');
      return ok([]);
    });
    const spy = vi.fn(fetch);
    await makeClient(spy).programs.list();
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('works as a thenable with catch and finally', async () => {
    const { fetch } = mockFetch(fail(404, 'NOT_FOUND', 'Member not found'), ok({ id: MEMBER_ID }));
    const client = makeClient(fetch);
    const onFinally = vi.fn();

    const caught = await client.members.get(MEMBER_ID).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(NotFoundError);
    await client.members.get(MEMBER_ID).finally(onFinally);
    expect(onFinally).toHaveBeenCalledOnce();
  });

  it('rejects invalid per-request options', async () => {
    const { fetch } = mockFetch();
    const client = makeClient(fetch);
    await expect(client.programs.list({ timeout: 0 })).rejects.toThrow(TypeError);
    await expect(client.programs.list({ maxRetries: -1 })).rejects.toThrow(TypeError);
  });

  it.each([1_500.5, 2 ** 31, Number.POSITIVE_INFINITY])(
    'refuses a timeout of %s before any request, without retrying',
    async (timeout) => {
      const { fetch, calls } = mockFetch();
      const client = makeClient(fetch);
      await expect(client.programs.list({ timeout })).rejects.toThrow(
        new TypeError('timeout must be an integer number of milliseconds from 1 to 2147483647.'),
      );
      expect(() => makeClient(fetch, { timeout })).toThrow(TypeError);
      expect(calls).toHaveLength(0);
    },
  );

  it('accepts the longest timeout a timer can wait for', async () => {
    const { fetch } = mockFetch(ok([]));
    await expect(makeClient(fetch, { timeout: 2_147_483_647 }).programs.list()).resolves.toEqual([]);
  });
});

describe('errors', () => {
  it.each([
    [400, 'VALIDATION_ERROR', BadRequestError],
    [401, 'INVALID_API_KEY', AuthenticationError],
    [402, 'BILLING_SUBSCRIPTION_REQUIRED', PaymentRequiredError],
    [403, 'FORBIDDEN', PermissionDeniedError],
    [404, 'NOT_FOUND', NotFoundError],
    [409, 'STAMP_CARD_FULL', ConflictError],
    [422, 'VALIDATION_ERROR', UnprocessableEntityError],
    [500, 'INTERNAL_ERROR', InternalServerError],
  ])('maps %i to its error class', async (status, code, ErrorClass) => {
    const { fetch } = mockFetch(
      fail(status, code, 'Something went wrong', {}, { 'x-correlation-id': 'req-9' }),
    );
    const error = await makeClient(fetch, { maxRetries: 0 })
      .members.get(MEMBER_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorClass);
    expect(error).toBeInstanceOf(StowApiError);
    expect(error).toBeInstanceOf(StowError);
    expect(error).toMatchObject({ status, code, requestId: 'req-9', name: ErrorClass.name });
    expect((error as Error).message).toBe(`${String(status)} ${code}: Something went wrong`);
  });

  it('exposes extra error fields as details', async () => {
    const { fetch } = mockFetch(
      fail(409, 'REDEEM_NOT_ELIGIBLE', 'Balance is below the reward target.', { current: 80, goal: 100 }),
    );
    const error = await makeClient(fetch)
      .members.redeemReward(MEMBER_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toEqual({ current: 80, goal: 100 });
  });

  it('reads the flat authentication error shape of older gateways', async () => {
    const { fetch } = mockFetch(
      json(401, { error: 'Invalid token.', code: 'INVALID_TOKEN', hint: 'rotate' }),
      json(401, { error: 'Access denied. No token provided.' }),
    );
    const client = makeClient(fetch);

    const invalid = await client.programs.list().catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(AuthenticationError);
    expect(invalid).toMatchObject({ code: 'INVALID_TOKEN', details: { hint: 'rotate' } });
    expect((invalid as Error).message).toBe('401 INVALID_TOKEN: Invalid token.');

    const missing = await client.programs.list().catch((e: unknown) => e);
    expect(missing).toMatchObject({
      code: 'HTTP_401',
      message: '401 HTTP_401: Access denied. No token provided.',
    });
  });

  it('reads a plain-text error body', async () => {
    const { fetch } = mockFetch(
      new Response('Too many requests from this IP, please try again later.', {
        status: 429,
        headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '900' },
      }),
    );
    const error = await makeClient(fetch)
      .programs.list()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ code: 'HTTP_429', retryAfterMs: 900_000 });
    expect((error as Error).message).toContain('Too many requests');
  });

  it('describes a status with no body', async () => {
    const { fetch } = mockFetch(new Response(null, { status: 418 }));
    const error = await makeClient(fetch)
      .programs.list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StowApiError);
    expect(error).toMatchObject({
      status: 418,
      code: 'HTTP_418',
      message: '418 HTTP_418: Request failed with status 418',
    });
  });

  it('treats a success status with success:false as an error', async () => {
    const { fetch } = mockFetch(
      json(200, { success: false, error: { code: 'PARTIAL', message: 'Partial' } }),
    );
    await expect(makeClient(fetch).programs.list()).rejects.toMatchObject({ status: 200, code: 'PARTIAL' });
  });

  it('never leaks the API key into an error', async () => {
    const { fetch } = mockFetch(fail(401, 'INVALID_API_KEY', 'Invalid or expired API key'));
    const error = await makeClient(fetch)
      .programs.list()
      .catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(String((error as Error).stack)).not.toContain(API_KEY);
  });
});

describe('retries', () => {
  it('retries an idempotent request on 503 and connection errors', async () => {
    const { fetch, calls } = mockFetch(
      fail(503, 'SERVICE_UNAVAILABLE', 'Try again'),
      connectionRefused(),
      ok([{ _id: 'p1' }]),
    );
    const { data, response } = await makeClient(fetch).programs.list().withResponse();

    expect(data).toEqual([{ _id: 'p1' }]);
    expect(response.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    // One correlation id for the whole logical call.
    expect(new Set(calls.map((call) => call.headers.get('x-correlation-id'))).size).toBe(1);
  });

  it('stops after maxRetries and throws the last error', async () => {
    const { fetch, calls } = mockFetch(
      fail(502, 'BAD_GATEWAY', 'a'),
      fail(502, 'BAD_GATEWAY', 'b'),
      fail(502, 'BAD_GATEWAY', 'c'),
    );
    const error = await makeClient(fetch)
      .programs.list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InternalServerError);
    expect((error as Error).message).toContain(': c');
    expect(calls).toHaveLength(3);
  });

  it('honours maxRetries: 0 per call', async () => {
    const { fetch, calls } = mockFetch(fail(503, 'SERVICE_UNAVAILABLE', 'x'));
    await expect(makeClient(fetch).programs.list({ maxRetries: 0 })).rejects.toBeInstanceOf(
      InternalServerError,
    );
    expect(calls).toHaveLength(1);
  });

  it('does not retry a non-idempotent request after a 5xx or network error', async () => {
    const first = mockFetch(fail(500, 'INTERNAL_ERROR', 'boom'));
    await expect(
      makeClient(first.fetch).webhooks.create({ name: 'hook', url: 'https://hooks.example.com/stow' }),
    ).rejects.toBeInstanceOf(InternalServerError);
    expect(first.calls).toHaveLength(1);

    const second = mockFetch(connectionRefused());
    await expect(makeClient(second.fetch).webhooks.test('sub_1')).rejects.toBeInstanceOf(StowConnectionError);
    expect(second.calls).toHaveLength(1);
  });

  it('never retries a pass push, which would alert the customer twice', async () => {
    const network = mockFetch(connectionRefused());
    await expect(makeClient(network.fetch).members.pushPass(MEMBER_ID)).rejects.toBeInstanceOf(
      StowConnectionError,
    );
    expect(network.calls).toHaveLength(1);

    const upstream = mockFetch(fail(503, 'SERVICE_UNAVAILABLE', 'down'));
    await expect(makeClient(upstream.fetch).members.pushPass(MEMBER_ID)).rejects.toBeInstanceOf(
      InternalServerError,
    );
    expect(upstream.calls).toHaveLength(1);
  });

  it('makes exactly one push attempt on a 429 or network error, whatever maxRetries says', async () => {
    const limited = mockFetch(
      fail(429, 'HTTP_429', 'slow down', {}, { 'retry-after': '0' }),
      ok({ pushed: true }),
    );
    await expect(
      makeClient(limited.fetch, { maxRetries: 5 }).members.pushPass(MEMBER_ID, undefined, { maxRetries: 5 }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(limited.calls).toHaveLength(1);

    const network = mockFetch(connectionRefused(), ok({ pushed: true }));
    await expect(
      makeClient(network.fetch).members.pushPass(MEMBER_ID, { changeMessage: 'Hi' }, { maxRetries: 3 }),
    ).rejects.toBeInstanceOf(StowConnectionError);
    expect(network.calls).toHaveLength(1);
  });

  it('retries any other request on 429 because it was not processed', async () => {
    const { fetch, calls } = mockFetch(
      fail(429, 'HTTP_429', 'slow down', {}, { 'retry-after': '0' }),
      ok({ id: 'sub_1', secret: 's' }, 201),
    );
    await makeClient(fetch).webhooks.create({ name: 'hook', url: 'https://hooks.example.com/stow' });
    expect(calls).toHaveLength(2);
  });

  it('waits for the server-requested Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { fetch, calls } = mockFetch(
      fail(429, 'HTTP_429', 'slow down', {}, { 'retry-after': '2' }),
      ok([]),
    );
    const result = makeClient(fetch).programs.list();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('surfaces a long Retry-After at once instead of blocking', async () => {
    const { fetch, calls } = mockFetch(fail(429, 'HTTP_429', 'window full', {}, { 'retry-after': '900' }));
    await expect(makeClient(fetch).programs.list()).rejects.toMatchObject({ retryAfterMs: 900_000 });
    expect(calls).toHaveLength(1);
  });

  it('reuses one idempotency key across retries of a balance change', async () => {
    const { fetch, calls } = mockFetch(
      connectionRefused(),
      ok({ previous: 50, current: 60 }, 200, { 'idempotency-replayed': 'true' }),
    );
    const { response } = await makeClient(fetch)
      .members.adjustPoints(MEMBER_ID, { delta: 10 })
      .withResponse();

    const keys = calls.map((call) => call.headers.get('idempotency-key'));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(response).toMatchObject({ idempotencyKey: keys[0], idempotencyReplayed: true, attempts: 2 });
  });

  it('retries a 409 only on a repeat of a keyed request', async () => {
    const inFlight = mockFetch(
      connectionRefused(),
      fail(409, 'IDEMPOTENCY_KEY_IN_USE', 'A request with this Idempotency-Key is already in progress'),
      ok({ previous: 1, current: 2 }),
    );
    await expect(makeClient(inFlight.fetch).members.adjustPoints(MEMBER_ID, { delta: 1 })).resolves.toEqual({
      previous: 1,
      current: 2,
    });
    expect(inFlight.calls).toHaveLength(3);

    // A plain `CONFLICT` on a retry is a refusal (here another request changed
    // the status first), so repeating it would overwrite that change.
    const refused = mockFetch(
      fail(500, 'INTERNAL_ERROR', 'x'),
      fail(409, 'CONFLICT', 'Member status changed concurrently, reload and retry'),
      ok({ previous: 'active', current: 'voided' }),
    );
    await expect(
      makeClient(refused.fetch).members.updateStatus(MEMBER_ID, { status: 'voided' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(refused.calls).toHaveLength(2);

    const genuine = mockFetch(fail(409, 'STAMP_CARD_FULL', 'This card is full.'));
    await expect(
      makeClient(genuine.fetch).members.adjustPoints(MEMBER_ID, { delta: 1 }),
    ).rejects.toMatchObject({
      code: 'STAMP_CARD_FULL',
    });
    expect(genuine.calls).toHaveLength(1);
  });

  it('never retries a business refusal after an earlier failed attempt', async () => {
    // A refused redemption notifies the customer, so a retry would alert them again.
    const { fetch, calls } = mockFetch(
      connectionRefused(),
      fail(409, 'REDEEM_NOT_ELIGIBLE', 'Balance is below the reward target.', { current: 80, goal: 100 }),
    );
    await expect(makeClient(fetch).members.redeemReward(MEMBER_ID)).rejects.toMatchObject({
      code: 'REDEEM_NOT_ELIGIBLE',
    });
    expect(calls).toHaveLength(2);
  });

  it('still retries a 5xx that carries the gateway rate-limit headers', async () => {
    const { fetch, calls } = mockFetch(
      fail(
        503,
        'SERVICE_UNAVAILABLE',
        'down',
        {},
        { 'ratelimit-reset': '900', 'ratelimit-remaining': '990' },
      ),
      ok([]),
    );
    await expect(makeClient(fetch).programs.list()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('never retries a CSV import or a webhook deletion after a network error or 5xx', async () => {
    const importing = mockFetch(connectionRefused());
    await expect(
      makeClient(importing.fetch).members.import({ programId: 'p1', file: 'a,b\n' }),
    ).rejects.toBeInstanceOf(StowConnectionError);
    expect(importing.calls).toHaveLength(1);

    const deleting = mockFetch(fail(502, 'BAD_GATEWAY', 'x'));
    await expect(makeClient(deleting.fetch).webhooks.delete('sub_1')).rejects.toBeInstanceOf(
      InternalServerError,
    );
    expect(deleting.calls).toHaveLength(1);
  });

  it('does not retry 4xx client errors', async () => {
    const { fetch, calls } = mockFetch(fail(400, 'BAD_REQUEST', 'nope'));
    await expect(makeClient(fetch).members.get(MEMBER_ID)).rejects.toBeInstanceOf(BadRequestError);
    expect(calls).toHaveLength(1);
  });
});

describe('timeouts and cancellation', () => {
  function hang(call: { signal: AbortSignal | null | undefined }): Promise<Response> {
    return new Promise((_resolve, reject) => {
      call.signal?.addEventListener('abort', () => {
        reject(call.signal?.reason as Error);
      });
    });
  }

  it('times out an attempt and retries idempotent calls', async () => {
    const { fetch, calls } = mockFetch(hang, ok([]));
    await expect(makeClient(fetch, { timeout: 20 }).programs.list()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('throws StowTimeoutError when every attempt times out', async () => {
    const { fetch } = mockFetch(hang);
    const error = await makeClient(fetch, { timeout: 20, maxRetries: 0 })
      .programs.list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StowTimeoutError);
    expect(error).toBeInstanceOf(StowConnectionError);
    expect((error as Error).message).toBe('Request timed out after 20 ms.');
  });

  it('rejects with StowAbortError when the caller aborts mid-request', async () => {
    const controller = new AbortController();
    const { fetch } = mockFetch((call) => {
      setTimeout(() => {
        controller.abort(new Error('user cancelled'));
      }, 5);
      return hang(call);
    });
    const error = await makeClient(fetch)
      .programs.list({ signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StowAbortError);
    expect((error as Error).cause).toEqual(new Error('user cancelled'));
  });

  it('does not send a request whose signal is already aborted', async () => {
    const { fetch, calls } = mockFetch();
    await expect(makeClient(fetch).programs.list({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      StowAbortError,
    );
    expect(calls).toHaveLength(0);
  });

  it('stops waiting between retries when aborted', async () => {
    vi.mocked(Math.random).mockReturnValue(0.99);
    const controller = new AbortController();
    const { fetch, calls } = mockFetch(fail(503, 'SERVICE_UNAVAILABLE', 'x'), ok([]));
    const result = makeClient(fetch).programs.list({ signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 10);
    await expect(result).rejects.toBeInstanceOf(StowAbortError);
    expect(calls).toHaveLength(1);
  });
});
