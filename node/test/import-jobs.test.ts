// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InternalServerError,
  NotFoundError,
  StowAbortError,
  StowConnectionError,
  StowTimeoutError,
  type ImportJob,
} from '../src/index.js';
import { connectionRefused, fail, makeClient, mockFetch, ok, page } from './helpers.js';

const JOBS = '/api/v1/merchants/me/members/import-jobs';
const JOB_ID = '66a1b2c3d4e5f6a7b8c9d0e1';

function path(call: { url: URL } | undefined): string {
  return call ? `${call.url.pathname}${call.url.search}` : '';
}

function job(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: JOB_ID,
    programId: 'p1',
    fileName: 'members.csv',
    status: 'queued',
    totalRows: 3,
    processedRows: 0,
    createdRows: 0,
    dedupedRows: 0,
    failedRows: 0,
    partialRows: 0,
    createdAt: '2026-10-13T09:00:00.000Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('members.startImport', () => {
  it('uploads the CSV as multipart form data and resolves with the queued job', async () => {
    const { fetch, calls } = mockFetch(ok(job(), 202));
    const csv = 'firstName,lastName,email\nAda,Lovelace,ada@example.com\n';
    const { data, response } = await makeClient(fetch)
      .members.startImport({ programId: 'p1', file: Buffer.from(csv) })
      .withResponse();

    expect(data).toEqual(job());
    expect(response.status).toBe(202);
    expect(calls[0]?.method).toBe('POST');
    expect(path(calls[0])).toBe(JOBS);
    const form = calls[0]?.body as FormData;
    expect(form.get('programId')).toBe('p1');
    const file = form.get('file') as File;
    expect(file.name).toBe('members.csv');
    expect(file.type).toBe('text/csv');
    expect(await file.text()).toBe(csv);
    // fetch sets the multipart boundary itself, and an upload carries no idempotency key.
    expect(calls[0]?.headers.get('content-type')).toBeNull();
    expect(calls[0]?.headers.get('idempotency-key')).toBeNull();
  });

  it('keeps the file name it is given', async () => {
    const { fetch, calls } = mockFetch(ok(job({ fileName: 'export.csv' }), 202), ok(job(), 202));
    const client = makeClient(fetch);
    await client.members.startImport({ programId: 'p1', file: 'a,b\n', filename: 'export.csv' });
    await client.members.startImport({ programId: 'p1', file: new File(['a,b\n'], 'spring-promo.csv') });
    expect(((calls[0]?.body as FormData).get('file') as File).name).toBe('export.csv');
    expect(((calls[1]?.body as FormData).get('file') as File).name).toBe('spring-promo.csv');
  });

  it('rejects an unsupported CSV value without a request', async () => {
    const { fetch, calls } = mockFetch();
    await expect(
      makeClient(fetch).members.startImport({ programId: 'p1', file: 42 as never }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('is never retried after a 5xx or a network error, which could start the import twice', async () => {
    const upstream = mockFetch(fail(502, 'SERVICE_UNAVAILABLE', 'down'), ok(job(), 202));
    await expect(
      makeClient(upstream.fetch).members.startImport({ programId: 'p1', file: 'a,b\n' }),
    ).rejects.toBeInstanceOf(InternalServerError);
    expect(upstream.calls).toHaveLength(1);

    const network = mockFetch(connectionRefused(), ok(job(), 202));
    await expect(
      makeClient(network.fetch).members.startImport({ programId: 'p1', file: 'a,b\n' }, { maxRetries: 3 }),
    ).rejects.toBeInstanceOf(StowConnectionError);
    expect(network.calls).toHaveLength(1);
  });

  it('is retried after a 429, because the upload was not accepted', async () => {
    const { fetch, calls } = mockFetch(
      fail(429, 'HTTP_429', 'slow down', {}, { 'retry-after': '0' }),
      ok(job(), 202),
    );
    await expect(
      makeClient(fetch).members.startImport({ programId: 'p1', file: 'a,b\n' }),
    ).resolves.toMatchObject({ id: JOB_ID });
    expect(calls).toHaveLength(2);
    expect(await ((calls[1]?.body as FormData).get('file') as File).text()).toBe('a,b\n');
  });
});

describe('members.getImport', () => {
  it('gets a job and encodes the path segment', async () => {
    const { fetch, calls } = mockFetch(ok(job({ status: 'running' })), fail(404, 'NOT_FOUND', 'x'));
    const client = makeClient(fetch);

    await expect(client.members.getImport(JOB_ID)).resolves.toMatchObject({ status: 'running' });
    await expect(client.members.getImport('a/b')).rejects.toBeInstanceOf(NotFoundError);
    expect(calls.map((call) => `${call.method} ${path(call)}`)).toEqual([
      `GET ${JOBS}/${JOB_ID}`,
      `GET ${JOBS}/a%2Fb`,
    ]);
  });

  it('refuses an empty job id', async () => {
    const { fetch } = mockFetch();
    await expect(makeClient(fetch).members.getImport('')).rejects.toThrow(TypeError);
  });
});

describe('members.listImportRows', () => {
  it('pages the rows with the status filter and page size', async () => {
    const failed = { rowNumber: 3, status: 'failed', email: 'bad', error: 'Invalid email' };
    const later = { rowNumber: 7, status: 'failed', error: 'Invalid email' };
    const { fetch, calls } = mockFetch(page([failed], 1, 1, 2), page([later], 2, 1, 2));

    const rows = [];
    for await (const row of makeClient(fetch).members.listImportRows(JOB_ID, {
      status: 'failed',
      pageSize: 1,
    })) {
      rows.push(row);
    }

    expect(rows).toEqual([failed, later]);
    expect(calls.map(path)).toEqual([
      `${JOBS}/${JOB_ID}/rows?status=failed&page=1&pageSize=1`,
      `${JOBS}/${JOB_ID}/rows?status=failed&page=2&pageSize=1`,
    ]);
  });

  it('starts at the requested page and omits unset filters', async () => {
    const created = {
      rowNumber: 2,
      status: 'created',
      email: 'ada@example.com',
      memberId: 'm1',
      passIssuance: { apple: true, google: false },
    };
    const { fetch, calls } = mockFetch(page([created], 3, 50, 101));
    const first = await makeClient(fetch).members.listImportRows(JOB_ID, { page: 3 });

    expect(first.items[0]?.passIssuance).toEqual({ apple: true, google: false });
    expect(first.total).toBe(101);
    expect(path(calls[0])).toBe(`${JOBS}/${JOB_ID}/rows?page=3`);
  });
});

describe('members.waitForImport', () => {
  it('polls at the interval until the job finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const done = job({ status: 'completed', processedRows: 3, createdRows: 2, failedRows: 1 });
    const { fetch, calls } = mockFetch(ok(job()), ok(job({ status: 'running', processedRows: 1 })), ok(done));
    const settled = vi.fn();
    const waiting = makeClient(fetch)
      .members.waitForImport(JOB_ID, { pollIntervalMs: 1_000 })
      .then((result) => {
        settled();
        return result;
      });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toEqual(done);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => path(call) === `${JOBS}/${JOB_ID}`)).toBe(true);
  });

  it.each(['failed', 'cancelled'] as const)('resolves with a %s job', async (status) => {
    const { fetch, calls } = mockFetch(ok(job({ status })));
    await expect(makeClient(fetch).members.waitForImport(JOB_ID)).resolves.toMatchObject({ status });
    expect(calls).toHaveLength(1);
  });

  it('polls every 3 seconds by default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { fetch, calls } = mockFetch(ok(job()), ok(job({ status: 'completed' })));
    const waiting = makeClient(fetch).members.waitForImport(JOB_ID);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects with a timeout error once the deadline passes, after a last poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const running = job({ status: 'running', processedRows: 1 });
    const { fetch, calls } = mockFetch(ok(running), ok(running), ok(running));
    const waiting = makeClient(fetch).members.waitForImport(JOB_ID, {
      pollIntervalMs: 1_000,
      timeoutMs: 1_500,
    });
    const outcome = expect(waiting).rejects.toThrow(StowTimeoutError);

    await vi.advanceTimersByTimeAsync(1_500);
    await outcome;
    await expect(waiting).rejects.toThrow(/did not finish within 1500 ms \(running, 1 of 3 rows/);
    // Polled at 0 ms, 1,000 ms and at the 1,500 ms deadline.
    expect(calls).toHaveLength(3);
  });

  it('stops waiting when the signal aborts, between polls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { fetch, calls } = mockFetch(ok(job()));
    const controller = new AbortController();
    const waiting = makeClient(fetch).members.waitForImport(JOB_ID, { signal: controller.signal });
    const outcome = expect(waiting).rejects.toBeInstanceOf(StowAbortError);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await outcome;
    expect(calls).toHaveLength(1);
  });

  it('makes no request when the signal has already aborted', async () => {
    const { fetch, calls } = mockFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeClient(fetch).members.waitForImport(JOB_ID, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(StowAbortError);
    expect(calls).toHaveLength(0);
  });

  it('passes a failed poll through', async () => {
    const { fetch } = mockFetch(fail(404, 'NOT_FOUND', 'Import job not found'));
    await expect(makeClient(fetch).members.waitForImport(JOB_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['pollIntervalMs', { pollIntervalMs: 0 }],
    ['pollIntervalMs', { pollIntervalMs: 1_500.5 }],
    // setTimeout fires at once for anything above 2^31 - 1, so a poll would never wait.
    ['pollIntervalMs', { pollIntervalMs: 2 ** 31 }],
    ['timeoutMs', { timeoutMs: -1 }],
    ['timeoutMs', { timeoutMs: Number.NaN }],
    ['timeoutMs', { timeoutMs: 2 ** 31 }],
  ])('refuses an invalid %s', async (name, options) => {
    const { fetch, calls } = mockFetch();
    await expect(makeClient(fetch).members.waitForImport(JOB_ID, options)).rejects.toThrow(
      new TypeError(`${name} must be an integer number of milliseconds from 1 to 2147483647.`),
    );
    expect(calls).toHaveLength(0);
  });
});
