// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { Page, PagePromise, StowError } from '../src/index.js';
import { makeClient, mockFetch, page } from './helpers.js';

const member = (n: number): { id: string; memberCode: string } => ({
  id: `m${String(n)}`,
  memberCode: `CODE${String(n)}`,
});

describe('pagination', () => {
  it('resolves to the first page with navigation helpers', async () => {
    const { fetch } = mockFetch(page([member(1), member(2)], 1, 2, 5), page([member(3), member(4)], 2, 2, 5));
    const list = makeClient(fetch).members.list({ pageSize: 2 });
    expect(list).toBeInstanceOf(PagePromise);
    expect(Object.prototype.toString.call(list)).toBe('[object PagePromise]');

    const first = await list;
    expect(first).toBeInstanceOf(Page);
    expect(first).toMatchObject({ page: 1, pageSize: 2, total: 5 });
    expect(first.response.status).toBe(200);
    expect(first.hasNextPage()).toBe(true);

    const second = await first.getNextPage();
    expect(second.items.map((m) => m.id)).toEqual(['m3', 'm4']);
  });

  it('walks every item across pages with for await', async () => {
    const { fetch, calls } = mockFetch(
      page([member(1), member(2)], 1, 2, 5),
      page([member(3), member(4)], 2, 2, 5),
      page([member(5)], 3, 2, 5),
    );
    const ids: string[] = [];
    for await (const item of makeClient(fetch).members.list({ pageSize: 2, programId: 'p1' }))
      ids.push(item.id);

    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(calls.map((call) => call.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    // Filters carry over to every page.
    expect(calls.every((call) => call.url.searchParams.get('programId') === 'p1')).toBe(true);
  });

  it('iterates page by page and can start mid-list', async () => {
    const { fetch } = mockFetch(page([member(3)], 2, 1, 3), page([member(4)], 3, 1, 3));
    const pages: number[] = [];
    const start = await makeClient(fetch).webhooks.list({ page: 2, pageSize: 1 });
    for await (const p of start.iterPages()) pages.push(p.page);
    expect(pages).toEqual([2, 3]);
  });

  it('stops at an empty page and refuses to go past the end', async () => {
    const { fetch, calls } = mockFetch(page([], 1, 25, 10));
    const first = await makeClient(fetch).members.list();
    expect(first.hasNextPage()).toBe(false);
    await expect(first.getNextPage()).rejects.toBeInstanceOf(StowError);

    const items: unknown[] = [];
    for await (const item of first) items.push(item);
    expect(items).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('propagates errors through catch and finally', async () => {
    const { fetch } = mockFetch(new Response('nope', { status: 400 }));
    let finished = false;
    const result = await makeClient(fetch)
      .members.list()
      .finally(() => {
        finished = true;
      })
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ status: 400 });
    expect(finished).toBe(true);
  });

  it('supports catch directly on the list promise', async () => {
    const { fetch } = mockFetch(new Response('nope', { status: 400 }));
    await expect(
      makeClient(fetch)
        .members.list()
        .catch(() => 'handled'),
    ).resolves.toBe('handled');
  });
});
