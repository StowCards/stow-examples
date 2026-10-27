// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { vi } from 'vitest';
import { StowClient, type StowClientOptions } from '../src/index.js';

export const API_KEY = 'stow_test_8Kf2pQ9xN3';
export const BASE_URL = 'https://api.stow.cards/api/v1';

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
  signal: AbortSignal | null | undefined;
}

type Reply = Response | Error | ((call: RecordedCall) => Response | Promise<Response>);

/** A fetch double that records each call and answers from a queue. */
export function mockFetch(...replies: Reply[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: init?.signal,
    };
    calls.push(call);
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`Unexpected request: ${call.method} ${call.url.href}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(call) : reply;
  });
  return { fetch: fetchImpl, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function ok(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return json(status, { success: true, data }, headers);
}

export function fail(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json(status, { success: false, error: { code, message, ...extra } }, headers);
}

export function page(items: unknown[], pageNumber: number, pageSize: number, total: number): Response {
  return ok({ items, page: pageNumber, pageSize, total });
}

export function connectionRefused(): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
}

export function makeClient(fetchImpl: typeof fetch, options: StowClientOptions = {}): StowClient {
  return new StowClient({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    logLevel: 'off',
    ...options,
  });
}

export function jsonBody(call: RecordedCall | undefined): unknown {
  return JSON.parse(typeof call?.body === 'string' ? call.body : '');
}
