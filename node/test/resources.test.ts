// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ApiPromise,
  MemberDetail,
  MemberWithProgram,
  Members,
  Page,
  PagePromise,
  ProgramSummary,
  Programs,
  UpdateMemberStatusResult,
  Webhooks,
} from '../src/index.js';
import { BASE_URL, jsonBody, makeClient, mockFetch, ok, page } from './helpers.js';

const MEMBER_ID = '665c1f00-0000-0000-0000-000000000000';
const MEMBERS = `${BASE_URL}/merchants/me/members`;

function path(call: { url: URL } | undefined): string {
  return call ? `${call.url.pathname}${call.url.search}` : '';
}

describe('programs', () => {
  it('lists and gets programs', async () => {
    const { fetch, calls } = mockFetch(
      ok([{ _id: 'p1', name: 'Coffee Club', status: 'active' }]),
      ok({ _id: 'p1' }),
    );
    const client = makeClient(fetch);

    await expect(client.programs.list()).resolves.toEqual([
      { _id: 'p1', name: 'Coffee Club', status: 'active' },
    ]);
    await client.programs.get('p1');
    expect(calls.map((call) => `${call.method} ${path(call)}`)).toEqual([
      'GET /api/v1/merchants/me/programs',
      'GET /api/v1/merchants/me/programs/p1',
    ]);
  });
});

describe('members', () => {
  it('enrols with only the documented fields', async () => {
    const { fetch, calls } = mockFetch(ok({ id: MEMBER_ID, memberCode: '7K2P9QX4M8' }, 201));
    const params = {
      programId: 'p1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      initialPoints: 50,
      phone: undefined,
      unexpected: 'dropped',
    };
    const member = await makeClient(fetch).members.enroll(params);

    expect(member.memberCode).toBe('7K2P9QX4M8');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.href).toBe(MEMBERS);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(jsonBody(calls[0])).toEqual({
      programId: 'p1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      initialPoints: 50,
    });
  });

  it('passes a deduped enrolment through', async () => {
    const { fetch } = mockFetch(ok({ id: MEMBER_ID, deduped: true }));
    const member = await makeClient(fetch).members.enroll({
      programId: 'p1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });
    expect(member.deduped).toBe(true);
  });

  it('passes through which wallet passes an enrolment issued', async () => {
    const { fetch } = mockFetch(
      ok({ id: MEMBER_ID, apple: { installed: false }, passIssuance: { apple: false, google: true } }, 201),
    );
    const member = await makeClient(fetch).members.enroll({
      programId: 'p1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });
    expect(member.passIssuance).toEqual({ apple: false, google: true });
  });

  it('passes through partial pass issuance on imported rows', async () => {
    const { fetch } = mockFetch(
      ok({
        summary: { totalRows: 2, created: 2, deduped: 0, failed: 0, partial: 1 },
        created: [
          { id: 'm1', email: 'ada@example.com', passIssuance: { apple: true, google: true } },
          { id: 'm2', email: 'alan@example.com', passIssuance: { apple: true, google: false } },
        ],
        deduped: [],
        failed: [],
      }),
    );
    const result = await makeClient(fetch).members.import({ programId: 'p1', file: 'a,b\n' });

    expect(result.summary.partial).toBe(1);
    expect(result.created.map((row) => row.passIssuance?.google)).toEqual([true, false]);
  });

  it('builds list queries and skips unset filters', async () => {
    const { fetch, calls } = mockFetch(page([], 2, 50, 0), page([], 1, 25, 0));
    const client = makeClient(fetch);

    await client.members.list({ programId: 'p1', q: 'Ada Love', page: 2, pageSize: 50 });
    await client.members.list();
    expect(path(calls[0])).toBe('/api/v1/merchants/me/members?programId=p1&q=Ada+Love&page=2&pageSize=50');
    expect(path(calls[1])).toBe('/api/v1/merchants/me/members?page=1');
  });

  it('sends every filter, repeating multi-value ones', async () => {
    const { fetch, calls } = mockFetch(page([], 1, 25, 0));
    await makeClient(fetch).members.list({
      programId: ['p1', 'p2'],
      status: 'active',
      passStatus: 'in_use',
      tag: ['vip', 'wholesale'],
      wallet: 'not_installed',
    });
    expect(path(calls[0])).toBe(
      '/api/v1/merchants/me/members?programId=p1&programId=p2&status=active&passStatus=in_use&tag=vip&tag=wholesale&wallet=not_installed&page=1',
    );
  });

  it('finds a member by code, or resolves null', async () => {
    const { fetch, calls } = mockFetch(
      page([{ id: MEMBER_ID, memberCode: '7K2P9QX4M8' }], 1, 1, 1),
      page([], 1, 1, 0),
    );
    const client = makeClient(fetch);

    await expect(client.members.findByCode(' 7K2P9QX4M8 ')).resolves.toMatchObject({ id: MEMBER_ID });
    await expect(client.members.findByCode('NOPE000000')).resolves.toBeNull();
    expect(path(calls[0])).toBe('/api/v1/merchants/me/members?memberCode=7K2P9QX4M8&pageSize=1');
    await expect(client.members.findByCode('  ')).rejects.toThrow(TypeError);
  });

  it('finds members by email or phone, narrowed by program', async () => {
    const { fetch, calls } = mockFetch(
      page([{ id: MEMBER_ID, email: 'ada@example.com' }], 1, 25, 1),
      page([{ id: MEMBER_ID, phone: '+44 7700 900123' }], 2, 10, 11),
    );
    const client = makeClient(fetch);

    const byEmail = await client.members.findByEmail(' ada@example.com ', { programId: 'p1' });
    const byPhone = await client.members.findByPhone('+44 7700 900123', {
      status: 'active',
      page: 2,
      pageSize: 10,
    });

    expect(byEmail.items).toEqual([{ id: MEMBER_ID, email: 'ada@example.com' }]);
    expect(byPhone.items[0]?.id).toBe(MEMBER_ID);
    expect(path(calls[0])).toBe('/api/v1/merchants/me/members?email=ada%40example.com&programId=p1&page=1');
    expect(path(calls[1])).toBe(
      '/api/v1/merchants/me/members?phone=%2B44+7700+900123&status=active&page=2&pageSize=10',
    );
    await expect(client.members.findByEmail('  ')).rejects.toThrow(TypeError);
    await expect(client.members.findByPhone('')).rejects.toThrow(TypeError);
  });

  it('passes email and phone filters through list', async () => {
    const { fetch, calls } = mockFetch(page([], 1, 25, 0));
    await makeClient(fetch).members.list({ email: 'ada@example.com', phone: '447700900123' });
    expect(path(calls[0])).toBe(
      '/api/v1/merchants/me/members?email=ada%40example.com&phone=447700900123&page=1',
    );
  });

  it('gets a member and encodes the path segment', async () => {
    const { fetch, calls } = mockFetch(ok({ id: 'a/b' }));
    await makeClient(fetch).members.get('a/b');
    expect(calls[0]?.url.pathname).toBe('/api/v1/merchants/me/members/a%2Fb');
  });

  it.each(['', '.', '..'])('rejects the member id %j without sending a request', async (memberId) => {
    const { fetch, calls } = mockFetch();
    await expect(makeClient(fetch).members.get(memberId)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('manages tags', async () => {
    const { fetch, calls } = mockFetch(
      ok({ tags: ['vip'] }),
      ok({ id: MEMBER_ID, tags: ['vip'] }),
      ok({ id: MEMBER_ID }),
    );
    const client = makeClient(fetch);

    await expect(client.members.listTags()).resolves.toEqual({ tags: ['vip'] });
    await client.members.addTags(MEMBER_ID, ['vip']);
    await client.members.removeTags(MEMBER_ID, ['vip']);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /api/v1/merchants/me/members/tags',
      `POST /api/v1/merchants/me/members/${MEMBER_ID}/tags`,
      `DELETE /api/v1/merchants/me/members/${MEMBER_ID}/tags`,
    ]);
    expect(jsonBody(calls[1])).toEqual({ tags: ['vip'] });
    await expect(client.members.addTags(MEMBER_ID, [])).rejects.toThrow(TypeError);
  });

  it('uploads a CSV import as multipart form data', async () => {
    const { fetch, calls } = mockFetch(
      ok({
        summary: { totalRows: 1, created: 1, deduped: 0, failed: 0 },
        created: [],
        deduped: [],
        failed: [],
      }),
    );
    const csv = 'firstName,lastName,email\nAda,Lovelace,ada@example.com\n';
    const result = await makeClient(fetch).members.import({ programId: 'p1', file: Buffer.from(csv) });

    expect(result.summary.created).toBe(1);
    const form = calls[0]?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('programId')).toBe('p1');
    const file = form.get('file') as File;
    expect(file.name).toBe('members.csv');
    expect(await file.text()).toBe(csv);
    // fetch sets the multipart boundary itself.
    expect(calls[0]?.headers.get('content-type')).toBeNull();
  });

  it.each([
    ['text', 'a,b\n'],
    ['blob', new Blob(['a,b\n'])],
    ['array buffer', new TextEncoder().encode('a,b\n').buffer],
  ])('accepts a CSV given as %s', async (_label, file) => {
    const { fetch, calls } = mockFetch(ok({}));
    await makeClient(fetch).members.import({ programId: 'p1', file, filename: 'export.csv' });
    const sent = (calls[0]?.body as FormData).get('file') as File;
    expect(sent.name).toBe('export.csv');
    expect(await sent.text()).toBe('a,b\n');
  });

  it('always uploads the CSV as text/csv, keeping a File name', async () => {
    const { fetch, calls } = mockFetch(ok({}), ok({}));
    const client = makeClient(fetch);

    // A Blob without a type would otherwise be application/octet-stream, which the API refuses.
    await client.members.import({ programId: 'p1', file: new Blob(['a,b\n']) });
    await client.members.import({ programId: 'p1', file: new File(['a,b\n'], 'spring-promo.csv') });

    const untyped = (calls[0]?.body as FormData).get('file') as File;
    const named = (calls[1]?.body as FormData).get('file') as File;
    expect(untyped.type).toBe('text/csv');
    expect(untyped.name).toBe('members.csv');
    expect(named.type).toBe('text/csv');
    expect(named.name).toBe('spring-promo.csv');
  });

  it('rejects an unsupported CSV value', async () => {
    const { fetch } = mockFetch();
    await expect(makeClient(fetch).members.import({ programId: 'p1', file: 42 as never })).rejects.toThrow(
      TypeError,
    );
  });

  it('adjusts points with an idempotency key', async () => {
    const { fetch, calls } = mockFetch(ok({ previous: 50, current: 60 }), ok({ previous: 60, current: 250 }));
    const client = makeClient(fetch);

    await client.members.adjustPoints(
      MEMBER_ID,
      { delta: 10, changeMessage: 'Thanks!' },
      { idempotencyKey: 'order-1234' },
    );
    await client.members.adjustPoints(MEMBER_ID, { value: 250 });

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe(`/api/v1/merchants/me/members/${MEMBER_ID}/points`);
    expect(calls[0]?.headers.get('idempotency-key')).toBe('order-1234');
    expect(jsonBody(calls[0])).toEqual({ delta: 10, changeMessage: 'Thanks!' });
    expect(calls[1]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(jsonBody(calls[1])).toEqual({ value: 250 });
  });

  it.each([
    [{}, /exactly one/],
    [{ delta: 1, value: 2 }, /exactly one/],
    [{ delta: 1.5 }, /integer/],
    [{ value: Number.NaN }, /integer/],
  ])('rejects the adjustment %j', async (params, message) => {
    const { fetch, calls } = mockFetch();
    await expect(makeClient(fetch).members.adjustPoints(MEMBER_ID, params as never)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it.each(['short', 'has space!', 'x'.repeat(129)])(
    'rejects the idempotency key %j',
    async (idempotencyKey) => {
      const { fetch } = mockFetch();
      await expect(
        makeClient(fetch).members.adjustPoints(MEMBER_ID, { delta: 1 }, { idempotencyKey }),
      ).rejects.toThrow(/idempotencyKey/);
    },
  );

  it('redeems a reward', async () => {
    const { fetch, calls } = mockFetch(ok({ previous: 130, current: 30 }), ok({ previous: 30, current: 0 }));
    const client = makeClient(fetch);

    await client.members.redeemReward(MEMBER_ID, { changeMessage: 'Free coffee' });
    await client.members.redeemReward(MEMBER_ID);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/v1/merchants/me/members/${MEMBER_ID}/redeem`);
    expect(calls[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(jsonBody(calls[0])).toEqual({ changeMessage: 'Free coffee' });
    expect(jsonBody(calls[1])).toEqual({});
  });

  it('updates status and distinguishes a no-op', async () => {
    const { fetch, calls } = mockFetch(
      ok({ member: { id: MEMBER_ID }, previous: 'active', current: 'voided', passUpdate: null }),
      ok({ id: MEMBER_ID, status: 'voided', unchanged: true }),
    );
    const client = makeClient(fetch);

    const changed: UpdateMemberStatusResult = await client.members.updateStatus(MEMBER_ID, {
      status: 'voided',
      reason: 'Fraud',
    });
    const unchanged = await client.members.updateStatus(MEMBER_ID, { status: 'voided' });

    expect('unchanged' in changed).toBe(false);
    expect('unchanged' in unchanged && unchanged.unchanged).toBe(true);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(jsonBody(calls[0])).toEqual({ status: 'voided', reason: 'Fraud' });
  });

  it('re-pushes a pass, with or without a message', async () => {
    const { fetch, calls } = mockFetch(
      ok({ member: { id: MEMBER_ID }, passUpdate: null }),
      ok({ member: { id: MEMBER_ID }, passUpdate: null }),
    );
    const client = makeClient(fetch);

    await client.members.pushPass(MEMBER_ID);
    await client.members.pushPass(MEMBER_ID, { changeMessage: 'Your reward is waiting' });
    expect(`${calls[0]?.method} ${calls[0]?.url.pathname}`).toBe(
      `POST /api/v1/merchants/me/members/${MEMBER_ID}/push`,
    );
    expect(jsonBody(calls[0])).toEqual({});
    expect(jsonBody(calls[1])).toEqual({ changeMessage: 'Your reward is waiting' });
  });

  it('reads events and pages transactions', async () => {
    const { fetch, calls } = mockFetch(
      ok({ items: [{ id: 'e1', eventType: 'pass_built', outcome: 'success' }] }),
      page([{ id: 't1', action: 'adjust' }], 1, 10, 1),
    );
    const client = makeClient(fetch);

    const events = await client.members.listEvents(MEMBER_ID, { limit: 10 });
    const transactions = await client.members.listTransactions(MEMBER_ID, { pageSize: 10 });

    expect(events.items[0]?.eventType).toBe('pass_built');
    expect(transactions.items).toEqual([{ id: 't1', action: 'adjust' }]);
    expect(path(calls[0])).toBe(`/api/v1/merchants/me/members/${MEMBER_ID}/events?limit=10`);
    expect(path(calls[1])).toBe(`/api/v1/merchants/me/members/${MEMBER_ID}/transactions?page=1&pageSize=10`);
  });
});

describe('webhooks', () => {
  it('covers subscription management', async () => {
    const subscription = { id: 'sub_1', name: 'hook', url: 'https://hooks.example.com/stow', events: ['*'] };
    const { fetch, calls } = mockFetch(
      ok({ ...subscription, secret: 'whsec' }, 201),
      page([subscription], 1, 25, 1),
      ok(subscription),
      ok({ ...subscription, enabled: false }),
      ok({ ...subscription, secret: 'whsec2' }),
      ok({ queued: true, eventType: 'member.updated', eventId: 'evt_1' }),
      page([], 1, 25, 0),
      ok({ queued: true, eventType: 'points.changed', eventId: 'evt_2' }),
      new Response(null, { status: 204 }),
    );
    const client = makeClient(fetch);

    const created = await client.webhooks.create({ name: 'hook', url: subscription.url, events: ['*'] });
    expect(created.secret).toBe('whsec');
    await client.webhooks.list({ enabled: true });
    await client.webhooks.get('sub_1');
    await client.webhooks.update('sub_1', { enabled: false });
    await client.webhooks.rotateSecret('sub_1');
    await client.webhooks.test('sub_1');
    await client.webhooks.listDeliveryLogs({
      subscriptionId: 'sub_1',
      success: false,
      eventType: 'points.changed',
    });
    await client.webhooks.replayDelivery('log_1');
    await client.webhooks.delete('sub_1');

    expect(calls.map((call) => `${call.method} ${path(call)}`)).toEqual([
      'POST /api/v1/merchants/me/webhooks',
      'GET /api/v1/merchants/me/webhooks?page=1&enabled=true',
      'GET /api/v1/merchants/me/webhooks/sub_1',
      'PATCH /api/v1/merchants/me/webhooks/sub_1',
      'POST /api/v1/merchants/me/webhooks/sub_1/rotate-secret',
      'POST /api/v1/merchants/me/webhooks/sub_1/test',
      'GET /api/v1/merchants/me/webhooks/delivery-logs?page=1&subscriptionId=sub_1&eventType=points.changed&success=false',
      'POST /api/v1/merchants/me/webhooks/delivery-logs/log_1/replay',
      'DELETE /api/v1/merchants/me/webhooks/sub_1',
    ]);
    expect(jsonBody(calls[0])).toEqual({ name: 'hook', url: subscription.url, events: ['*'] });
    expect(jsonBody(calls[3])).toEqual({ enabled: false });
  });
});

describe('a member whose program is gone', () => {
  it('types and returns the program as null', async () => {
    const { fetch } = mockFetch(ok({ id: MEMBER_ID, program: null, deviceCount: 0, redeemedCount: 0 }));
    const member = await makeClient(fetch).members.get(MEMBER_ID);
    expect(member.program).toBeNull();
    expectTypeOf<MemberDetail['program']>().toEqualTypeOf<ProgramSummary | null>();
    expectTypeOf<MemberWithProgram['program']>().toEqualTypeOf<ProgramSummary | null | undefined>();
  });
});

describe('SDK-created classes', () => {
  it('publish no public constructor', () => {
    // A type check (run by `npm run typecheck`): the declarations keep a private
    // constructor, so the API report never implies a public one.
    type IsNewable<T> = T extends new (...args: never[]) => unknown ? true : false;
    type Classes =
      | typeof Members
      | typeof Programs
      | typeof Webhooks
      | typeof ApiPromise
      | typeof Page
      | typeof PagePromise;
    const noneNewable: true extends IsNewable<Classes> ? never : true = true;
    expect(noneNewable).toBe(true);
  });
});
