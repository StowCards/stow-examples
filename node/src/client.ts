// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { StowError } from './core/errors.js';
import { LevelLogger, type LogLevel, type Logger, isLogLevel } from './core/logger.js';
import { Transport, assertTimeoutMs } from './core/transport.js';
import { Members } from './resources/members.js';
import { Programs } from './resources/programs.js';
import { Webhooks } from './resources/webhooks.js';
import { VERSION } from './version.js';

/** The production API base URL. */
export const DEFAULT_BASE_URL = 'https://api.stow.cards/api/v1';
/** Default per-attempt timeout: 30 seconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default number of retries after the first attempt. */
export const DEFAULT_MAX_RETRIES = 2;

/** Identifies your application in the `User-Agent` header, which helps support trace your traffic. */
export interface AppInfo {
  /** Your application's name, e.g. `acme-pos`. */
  name: string;
  /** Your application's version, e.g. `4.2.0`. */
  version?: string | undefined;
  /** A URL where the Stow Cards team can learn about your integration. */
  url?: string | undefined;
}

/** Options of {@link StowClient}. */
export interface StowClientOptions {
  /**
   * Your `stow_…` API key. Defaults to the `STOW_API_KEY` environment
   * variable. Keep it on your server: never ship it to a browser or app.
   */
  apiKey?: string | undefined;
  /**
   * API base URL including `/api/v1`. Defaults to the `STOW_BASE_URL`
   * environment variable, then to {@link DEFAULT_BASE_URL}.
   */
  baseUrl?: string | undefined;
  /**
   * Per-attempt timeout in milliseconds, an integer from 1 to 2147483647.
   * Defaults to 30,000.
   */
  timeout?: number | undefined;
  /**
   * Retries after the first attempt for failures that are safe to repeat
   * (network errors, timeouts, 408, 429 and 5xx). Defaults to 2; `0`
   * disables retries. A pass push is never retried, not even after a 429.
   */
  maxRetries?: number | undefined;
  /**
   * A `fetch` implementation, for proxies, instrumentation or tests.
   * Defaults to the global `fetch`.
   */
  fetch?: typeof fetch | undefined;
  /** Headers added to every request. */
  defaultHeaders?: Record<string, string> | undefined;
  /** Identifies your application in the `User-Agent` header. */
  appInfo?: AppInfo | undefined;
  /** Where the SDK writes log lines. Defaults to `console`. */
  logger?: Logger | undefined;
  /**
   * Minimum level written to {@link StowClientOptions.logger}. Defaults to
   * the `STOW_LOG` environment variable, then to `warn`.
   */
  logLevel?: LogLevel | undefined;
  /**
   * Allow a plain-HTTP base URL on a host other than localhost. Leave this off
   * in production: the API key would cross the network unencrypted.
   */
  allowInsecureHttp?: boolean | undefined;
  /**
   * Allow construction where `window` and `document` exist, such as a jsdom
   * test environment. The SDK refuses by default because in a real browser the
   * API key would be exposed to every visitor; the API's CORS settings do not
   * allow the SDK's headers from browsers either.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
}

/**
 * Client for the Stow Cards API.
 *
 * Create one per API key and reuse it: it holds no per-request state and is
 * safe to share across concurrent calls.
 *
 * @example
 * ```ts
 * import { StowClient } from '@stowcards/sdk';
 *
 * const stow = new StowClient({ apiKey: process.env.STOW_API_KEY });
 * const programs = await stow.programs.list();
 * ```
 */
export class StowClient {
  /** Read the merchant's pass programs. */
  readonly programs: Programs;
  /** Enrol members, manage their wallet passes, change balances and read history. */
  readonly members: Members;
  /** Manage outbound webhook subscriptions and delivery logs. */
  readonly webhooks: Webhooks;
  /** The API base URL this client calls. */
  readonly baseUrl: string;

  constructor(options: StowClientOptions = {}) {
    if (isBrowser() && options.dangerouslyAllowBrowser !== true) {
      throw new StowError(
        'StowClient refuses to run in a browser because the API key would be exposed to every visitor. ' +
          'Call the Stow Cards API from your server instead.',
      );
    }

    const apiKey = (options.apiKey ?? env('STOW_API_KEY'))?.trim();
    if (apiKey === undefined || apiKey === '') {
      throw new StowError(
        'Missing API key. Pass { apiKey } or set the STOW_API_KEY environment variable. ' +
          'Create a key in the Stow Cards console under Administration, API Keys.',
      );
    }
    // Keys are printable ASCII; anything else (a pasted line break, say) would corrupt the header.
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new StowError('The API key contains whitespace, control or non-ASCII characters.');
    }

    this.baseUrl = normaliseBaseUrl(
      options.baseUrl ?? env('STOW_BASE_URL') ?? DEFAULT_BASE_URL,
      options.allowInsecureHttp === true,
    );

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new StowError('No fetch implementation found. Use Node.js 22 or later, or pass { fetch }.');
    }

    const envLevel = env('STOW_LOG');
    const logLevel = options.logLevel ?? (isLogLevel(envLevel) ? envLevel : 'warn');
    if (!isLogLevel(logLevel)) {
      throw new TypeError('logLevel must be one of debug, info, warn, error or off.');
    }

    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    assertTimeoutMs('timeout', timeout);

    const transport = new Transport({
      apiKey,
      baseUrl: this.baseUrl,
      timeout,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      fetch: fetchImpl,
      defaultHeaders: { ...options.defaultHeaders },
      userAgent: userAgent(options.appInfo),
      logger: new LevelLogger(options.logger ?? console, logLevel),
    });

    this.programs = Programs._create(transport);
    this.members = Members._create(transport);
    this.webhooks = Webhooks._create(transport);
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

function normaliseBaseUrl(value: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StowError(`Invalid baseUrl: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new StowError('baseUrl must use https.');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol === 'http:' && !loopback && !allowInsecureHttp) {
    throw new StowError(
      'baseUrl must use https outside localhost, so the API key is never sent unencrypted. ' +
        'Set allowInsecureHttp only for a trusted private network.',
    );
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new StowError('baseUrl must not contain credentials, a query string or a fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

function userAgent(appInfo: AppInfo | undefined): string {
  const runtime =
    typeof process === 'undefined'
      ? 'runtime/unknown'
      : `node/${process.version} (${process.platform}; ${process.arch})`;
  let agent = `stowcards-node/${VERSION} ${runtime}`;
  if (appInfo !== undefined) {
    const token = /^[A-Za-z0-9._~+-]+$/;
    if (!token.test(appInfo.name) || (appInfo.version !== undefined && !token.test(appInfo.version))) {
      throw new TypeError('appInfo.name and appInfo.version may contain only letters, digits and ._~+-');
    }
    if (appInfo.url !== undefined && !/^https?:\/\/[^\s()]+$/.test(appInfo.url)) {
      throw new TypeError('appInfo.url must be an http(s) URL without spaces or parentheses.');
    }
    agent += ` ${appInfo.name}${appInfo.version === undefined ? '' : `/${appInfo.version}`}`;
    if (appInfo.url !== undefined) agent += ` (+${appInfo.url})`;
  }
  return agent;
}

function env(name: string): string | undefined {
  if (typeof process === 'undefined') return undefined;
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function isBrowser(): boolean {
  return 'window' in globalThis && 'document' in globalThis;
}
