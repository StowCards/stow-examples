// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal, pluggable logging.
 *
 * The SDK never logs API keys, request bodies, response bodies or query
 * strings (a member search query can be an email address). Log lines carry
 * the method, the path, the status, the attempt number and the request id.
 */

/** Log verbosity, most to least verbose. `off` silences the SDK. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

/**
 * Any object with these four methods, for example `console`, a `pino` or
 * `winston` logger, or your own adapter.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LEVELS: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
};

/** @internal */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}

/** @internal Wraps a {@link Logger} and drops lines below the level. */
export class LevelLogger {
  readonly #logger: Logger;
  readonly #threshold: number;

  constructor(logger: Logger, level: LogLevel) {
    this.#logger = logger;
    this.#threshold = LEVELS[level];
  }

  debug(message: string): void {
    if (this.#threshold <= LEVELS.debug) this.#logger.debug(`[stow] ${message}`);
  }

  info(message: string): void {
    if (this.#threshold <= LEVELS.info) this.#logger.info(`[stow] ${message}`);
  }

  warn(message: string): void {
    if (this.#threshold <= LEVELS.warn) this.#logger.warn(`[stow] ${message}`);
  }
}
