// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BASE_URL, StowClient, StowError, VERSION } from '../src/index.js';
import { mockFetch, ok } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('StowClient construction', () => {
  it('reads the API key and base URL from the environment', async () => {
    vi.stubEnv('STOW_API_KEY', '  stow_from_env\n');
    vi.stubEnv('STOW_BASE_URL', 'http://localhost:6060/api/v1/');
    const { fetch, calls } = mockFetch(ok([]));
    const client = new StowClient({ fetch, logLevel: 'off' });

    expect(client.baseUrl).toBe('http://localhost:6060/api/v1');
    await client.programs.list();
    expect(calls[0]?.url.href).toBe('http://localhost:6060/api/v1/merchants/me/programs');
    expect(calls[0]?.headers.get('x-api-key')).toBe('stow_from_env');
  });

  it('defaults to the production API', () => {
    vi.stubEnv('STOW_BASE_URL', '');
    expect(new StowClient({ apiKey: 'stow_x' }).baseUrl).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe('https://api.stow.cards/api/v1');
  });

  it('requires an API key', () => {
    vi.stubEnv('STOW_API_KEY', '');
    expect(() => new StowClient()).toThrow(StowError);
    expect(() => new StowClient({ apiKey: '   ' })).toThrow(/Missing API key/);
    expect(() => new StowClient({ apiKey: 'stow_a\r\nX-Evil: 1' })).toThrow(/control or non-ASCII/);
  });

  it('never exposes the API key on the instance', () => {
    const client = new StowClient({ apiKey: 'stow_secret_value' });
    expect(JSON.stringify(client)).not.toContain('stow_secret_value');
    expect(Object.values(client).map(String).join()).not.toContain('stow_secret_value');
  });

  it.each([
    ['http://api.example.com/api/v1', /must use https/],
    ['ftp://api.example.com', /must use https/],
    ['not a url', /Invalid baseUrl/],
    ['https://user:pass@api.example.com/api/v1', /credentials/],
    ['https://api.example.com/api/v1?x=1', /query string/],
  ])('rejects the base URL %s', (baseUrl, message) => {
    expect(() => new StowClient({ apiKey: 'stow_x', baseUrl })).toThrow(message);
  });

  it.each([
    'http://localhost:6060/api/v1',
    'http://127.0.0.1:6060/api/v1',
    'http://[::1]:6060',
    'http://api.localhost',
  ])('allows plain HTTP on the loopback host %s', (baseUrl) => {
    expect(() => new StowClient({ apiKey: 'stow_x', baseUrl })).not.toThrow();
  });

  it('allows plain HTTP elsewhere only when opted in', () => {
    const client = new StowClient({
      apiKey: 'stow_x',
      baseUrl: 'http://api.internal.example:8080/api/v1',
      allowInsecureHttp: true,
    });
    expect(client.baseUrl).toBe('http://api.internal.example:8080/api/v1');
  });

  it('refuses to run in a browser unless explicitly allowed', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(() => new StowClient({ apiKey: 'stow_x' })).toThrow(/browser/);
    expect(() => new StowClient({ apiKey: 'stow_x', dangerouslyAllowBrowser: true })).not.toThrow();
  });

  it('validates appInfo and logLevel', () => {
    expect(() => new StowClient({ apiKey: 'stow_x', appInfo: { name: 'bad name' } })).toThrow(TypeError);
    expect(
      () => new StowClient({ apiKey: 'stow_x', appInfo: { name: 'pos', url: 'javascript:alert(1)' } }),
    ).toThrow(TypeError);
    expect(() => new StowClient({ apiKey: 'stow_x', logLevel: 'verbose' as never })).toThrow(TypeError);
  });

  it('fails clearly without a fetch implementation', () => {
    vi.stubGlobal('fetch', undefined);
    expect(() => new StowClient({ apiKey: 'stow_x' })).toThrow(/fetch/);
  });
});

describe('logging', () => {
  it('logs retries at info and requests at debug, without secrets or query strings', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { fetch } = mockFetch(
      new Response('{"success":false,"error":{"code":"X","message":"y"}}', { status: 503 }),
      ok({ items: [], page: 1, pageSize: 25, total: 0 }),
    );
    const client = new StowClient({ apiKey: 'stow_secret_value', fetch, logger, logLevel: 'debug' });
    await client.members.list({ q: 'ada@example.com' });

    const lines = [...logger.debug.mock.calls, ...logger.info.mock.calls].map((args) => String(args[0]));
    expect(lines.some((line) => line.startsWith('[stow] GET /merchants/me/members attempt 1'))).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('retry 1/2'));
    expect(lines.join('\n')).not.toMatch(/stow_secret_value|ada@example\.com/);
  });

  it('is quiet at the default level and honours STOW_LOG', async () => {
    vi.stubEnv('STOW_LOG', 'debug');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { fetch } = mockFetch(ok([]), ok([]));
    await new StowClient({ apiKey: 'stow_x', fetch, logger }).programs.list();
    expect(logger.debug).toHaveBeenCalled();

    vi.stubEnv('STOW_LOG', '');
    logger.debug.mockClear();
    await new StowClient({ apiKey: 'stow_x', fetch, logger }).programs.list();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
