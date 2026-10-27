// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import type { ApiPromise } from '../core/api-promise.js';
import { segment } from '../core/path.js';
import type { RequestOptions, Transport } from '../core/transport.js';
import type { Program } from '../models.js';

/**
 * Read the merchant's pass programs. Programs are designed and published in
 * the web console's Pass Designer; the API is read-only.
 */
export class Programs {
  readonly #transport: Transport;

  // Private, so the declarations publish no constructor: use StowClient.
  private constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** @internal */
  static _create(transport: Transport): Programs {
    return new Programs(transport);
  }

  /**
   * List the merchant's programs.
   *
   * @example
   * ```ts
   * const programs = await stow.programs.list();
   * const programId = programs.find((p) => p.status === 'active')?._id;
   * ```
   */
  list(options?: RequestOptions): ApiPromise<Program[]> {
    return this.#transport.request(() => ({
      method: 'GET',
      path: '/merchants/me/programs',
      idempotent: true,
      options,
    }));
  }

  /**
   * Get one program by its `_id`.
   *
   * @throws {@link NotFoundError} when no such program exists in your merchant.
   */
  get(programId: string, options?: RequestOptions): ApiPromise<Program> {
    return this.#transport.request(() => ({
      method: 'GET',
      path: `/merchants/me/programs/${segment('programId', programId)}`,
      idempotent: true,
      options,
    }));
  }
}
