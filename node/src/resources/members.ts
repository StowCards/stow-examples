// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import type { ApiPromise } from '../core/api-promise.js';
import type { PagePromise } from '../core/pagination.js';
import { StowTimeoutError } from '../core/errors.js';
import { segment } from '../core/path.js';
import {
  type IdempotentRequestOptions,
  type RequestOptions,
  type RequestSpec,
  Transport,
  assertTimeoutMs,
  sleep,
} from '../core/transport.js';
import type {
  AdjustPointsParams,
  BalanceChangeResult,
  CsvFile,
  EnrollMemberParams,
  EnrolledMember,
  FindMembersParams,
  ImportJob,
  ImportJobRow,
  ImportMembersParams,
  ImportMembersResult,
  ListImportRowsParams,
  ListMemberEventsParams,
  ListMembersParams,
  MemberDetail,
  MemberEventList,
  MemberTransaction,
  MemberWithProgram,
  PageParams,
  PushPassParams,
  PushPassResult,
  RedeemRewardParams,
  TagList,
  TaggedMember,
  UpdateMemberStatusParams,
  UpdateMemberStatusResult,
  WaitForImportOptions,
} from '../models.js';

const BASE = '/merchants/me/members';

/** Import job statuses after which nothing changes any more. */
const FINISHED_IMPORT_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Enrol customers, manage their wallet passes, change balances and read
 * their history.
 *
 * Changing a member's points or status rebuilds the Apple and Google Wallet
 * pass and pushes the update to the customer's phone automatically.
 */
export class Members {
  readonly #transport: Transport;

  // Private, so the declarations publish no constructor: use StowClient.
  private constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** @internal */
  static _create(transport: Transport): Members {
    return new Members(transport);
  }

  /**
   * Enrol a customer into a program and issue their wallet passes.
   *
   * Enrolment dedupes on `(programId, email)`: an existing member is
   * returned with `deduped: true` and nothing is created, which makes this
   * call safe to retry. `deduped` is therefore also `true` when the SDK
   * retried a request whose first attempt had already enrolled the member.
   * A deduped answer that arrives while the first request is still building
   * the wallet passes waits for them (up to 20 seconds), and its
   * `passIssuance` reflects the links the member has stored.
   *
   * @example
   * ```ts
   * const member = await stow.members.enroll({
   *   programId,
   *   firstName: 'Ada',
   *   lastName: 'Lovelace',
   *   email: 'ada@example.com',
   * });
   * console.log(member.memberCode, member.apple?.passUrl, member.google?.saveUrl);
   * ```
   */
  enroll(params: EnrollMemberParams, options?: RequestOptions): ApiPromise<EnrolledMember> {
    return this.#transport.request(() => ({
      method: 'POST',
      path: BASE,
      body: pick(params, ['programId', 'firstName', 'lastName', 'email', 'phone', 'initialPoints']),
      idempotent: true,
      options,
    }));
  }

  /**
   * List, search and filter members, newest first. Each item embeds a
   * `program` summary.
   *
   * Await it for the first page, or iterate it with `for await` to walk
   * every match across all pages.
   */
  list(params?: ListMembersParams, options?: RequestOptions): PagePromise<MemberWithProgram> {
    return this.#transport.list(
      (page) => ({
        method: 'GET',
        path: BASE,
        query: {
          programId: params?.programId,
          q: params?.q,
          email: params?.email,
          phone: params?.phone,
          status: params?.status,
          passStatus: params?.passStatus,
          tag: params?.tag,
          wallet: params?.wallet,
          page,
          pageSize: params?.pageSize,
        },
        idempotent: true,
        options,
      }),
      params?.page,
    );
  }

  /**
   * Find the members with this email address (exact, any letter case),
   * newest first. A customer can hold a pass in several programs, so this can
   * match more than one member; pass `programId` to pick one program.
   *
   * @example
   * ```ts
   * const { items } = await stow.members.findByEmail('ada@example.com', { programId });
   * ```
   */
  findByEmail(
    email: string,
    params?: FindMembersParams,
    options?: RequestOptions,
  ): PagePromise<MemberWithProgram> {
    return this.#findBy('email', email, params, options);
  }

  /**
   * Find the members with this phone number, newest first. The number is
   * matched by its digits (at least 6), ignoring spaces, dashes, brackets and
   * a leading `+`, so `+44 7700 900123` finds `447700900123`. Give it the way
   * the customer gave it, including the country code if they did. Like
   * {@link Members.findByEmail}, it can match one member per program.
   */
  findByPhone(
    phone: string,
    params?: FindMembersParams,
    options?: RequestOptions,
  ): PagePromise<MemberWithProgram> {
    return this.#findBy('phone', phone, params, options);
  }

  #findBy(
    field: 'email' | 'phone',
    value: string,
    params: FindMembersParams | undefined,
    options: RequestOptions | undefined,
  ): PagePromise<MemberWithProgram> {
    return this.#transport.list((page) => {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${field} must be a non-empty string.`);
      }
      return {
        method: 'GET',
        path: BASE,
        query: {
          [field]: value.trim(),
          programId: params?.programId,
          status: params?.status,
          page,
          pageSize: params?.pageSize,
        },
        idempotent: true,
        options,
      };
    }, params?.page);
  }

  /**
   * Find a member by the Member ID (`memberCode`) printed on and encoded in
   * their pass, or by a legacy pass serial. Resolves to `null` when nothing
   * matches.
   *
   * A scanner reads the whole barcode value (for example
   * `MEMBER-7K2P9QX4M8`); turn it into a code with {@link parseMemberBarcode}
   * first.
   *
   * @example
   * ```ts
   * const code = parseMemberBarcode(scannedText);
   * const member = code ? await stow.members.findByCode(code) : null;
   * ```
   */
  findByCode(memberCode: string, options?: RequestOptions): Promise<MemberWithProgram | null> {
    const page = this.#transport.list<MemberWithProgram>(() => {
      if (typeof memberCode !== 'string' || memberCode.trim() === '') {
        throw new TypeError('memberCode must be a non-empty string.');
      }
      return {
        method: 'GET',
        path: BASE,
        query: { memberCode: memberCode.trim(), pageSize: 1 },
        idempotent: true,
        options,
      };
    }, 1);
    return page.then((first) => first.items[0] ?? null);
  }

  /**
   * Get the full member: wallet pass state, a program snapshot, the number of
   * registered wallet devices and the lifetime redemption count.
   *
   * @param memberId - The member's `id` (UUID), not the `memberCode`.
   * @throws {@link NotFoundError} when no such member exists in your merchant.
   */
  get(memberId: string, options?: RequestOptions): ApiPromise<MemberDetail> {
    return this.#transport.request(() => ({
      method: 'GET',
      path: `${BASE}/${segment('memberId', memberId)}`,
      idempotent: true,
      options,
    }));
  }

  /** List every distinct tag in use across your members. */
  listTags(options?: RequestOptions): ApiPromise<TagList> {
    return this.#transport.request(() => ({
      method: 'GET',
      path: `${BASE}/tags`,
      idempotent: true,
      options,
    }));
  }

  /**
   * Add tags to a member (deduplicated and normalised; at most 25 per member).
   * Resolves with `unchanged: true` when every tag was already present,
   * which includes a retry after a first attempt that added them: check
   * `response.attempts` through `.withResponse()` before treating
   * `unchanged` as "nothing happened".
   */
  addTags(memberId: string, tags: readonly string[], options?: RequestOptions): ApiPromise<TaggedMember> {
    return this.#transport.request(() => ({
      method: 'POST',
      path: `${BASE}/${segment('memberId', memberId)}/tags`,
      body: { tags: tagList(tags) },
      idempotent: true,
      options,
    }));
  }

  /**
   * Remove tags from a member. Unknown tags are ignored. Like
   * {@link Members.addTags}, `unchanged: true` can follow a retry of a first
   * attempt that removed them.
   */
  removeTags(memberId: string, tags: readonly string[], options?: RequestOptions): ApiPromise<TaggedMember> {
    return this.#transport.request(() => ({
      method: 'DELETE',
      path: `${BASE}/${segment('memberId', memberId)}/tags`,
      body: { tags: tagList(tags) },
      idempotent: true,
      options,
    }));
  }

  /**
   * Bulk-enrol members from a CSV file (at most 1 MB and 5,000 rows) inside
   * this one request. Rows whose email is already enrolled come back as
   * `deduped`. Prefer this to a loop of {@link Members.enroll} calls.
   *
   * Every row builds wallet passes before the answer comes back, and the API
   * gateway allows a request 30 seconds, so this suits small files only.
   * Start anything larger as a background job with
   * {@link Members.startImport}.
   *
   * Not retried automatically after a network error or 5xx: the rows an
   * interrupted upload had already enrolled would come back as `deduped`, so
   * the summary would no longer describe this file. Re-run it yourself if
   * needed; nothing is enrolled twice.
   *
   * @throws {@link BadRequestError} when the file is over 1 MB
   * (`CSV_FILE_TOO_LARGE`), or the CSV does not parse, has no rows or has
   * more than 5,000.
   *
   * @example
   * ```ts
   * import { readFile } from 'node:fs/promises';
   * const result = await stow.members.import({ programId, file: await readFile('members.csv') });
   * console.log(result.summary);
   * ```
   */
  import(params: ImportMembersParams, options?: RequestOptions): ApiPromise<ImportMembersResult> {
    return this.#transport.request(() => csvUpload(`${BASE}/import`, params, options));
  }

  /**
   * Start a background import of a CSV file (at most 1 MB and 5,000 rows)
   * and resolve as soon as it is queued. The file takes the same columns as
   * {@link Members.import}, and every row is validated on upload: a row that
   * fails validation is recorded as `failed` straight away. A worker then
   * enrols the rest one at a time. Follow it with
   * {@link Members.waitForImport} or {@link Members.getImport}, or listen for
   * the `batch.completed` and `batch.failed` webhooks, whose
   * `data.batchJobId` is the job's `id`.
   *
   * Not retried automatically after a network error or 5xx, which could
   * start the same import twice (a 429 is still retried, since the upload
   * was not accepted). A second job for the same file enrols nothing twice:
   * its rows come back as `deduped`.
   *
   * @throws {@link BadRequestError} when the file is over 1 MB
   * (`CSV_FILE_TOO_LARGE`), the CSV does not parse, has no rows or has more
   * than 5,000, or the program is archived.
   * @throws {@link NotFoundError} when the program does not exist.
   *
   * @example
   * ```ts
   * import { readFile } from 'node:fs/promises';
   * const job = await stow.members.startImport({ programId, file: await readFile('members.csv') });
   * const done = await stow.members.waitForImport(job.id);
   * console.log(done.status, done.createdRows, done.failedRows);
   * ```
   */
  startImport(params: ImportMembersParams, options?: RequestOptions): ApiPromise<ImportJob> {
    return this.#transport.request(() => csvUpload(`${BASE}/import-jobs`, params, options));
  }

  /**
   * Get an import job with its current counts.
   *
   * @throws {@link NotFoundError} when no such import job exists in your
   * merchant.
   */
  getImport(jobId: string, options?: RequestOptions): ApiPromise<ImportJob> {
    return this.#transport.request(() => ({
      method: 'GET',
      path: `${BASE}/import-jobs/${segment('jobId', jobId)}`,
      idempotent: true,
      options,
    }));
  }

  /**
   * List the rows of an import job in file order, optionally only those with
   * one outcome (for example the `failed` rows, with their `error`).
   *
   * @example
   * ```ts
   * for await (const row of stow.members.listImportRows(job.id, { status: 'failed' })) {
   *   console.log(row.rowNumber, row.email, row.error);
   * }
   * ```
   */
  listImportRows(
    jobId: string,
    params?: ListImportRowsParams,
    options?: RequestOptions,
  ): PagePromise<ImportJobRow> {
    return this.#transport.list(
      (page) => ({
        method: 'GET',
        path: `${BASE}/import-jobs/${segment('jobId', jobId)}/rows`,
        query: { status: params?.status, page, pageSize: params?.pageSize },
        idempotent: true,
        options,
      }),
      params?.page,
    );
  }

  /**
   * Poll an import job until it is `completed`, `failed` or `cancelled`, and
   * resolve with it. A `completed` job can still have failed rows: check
   * `failedRows` and list them with {@link Members.listImportRows}.
   *
   * Each poll is an ordinary {@link Members.getImport} call, retried like
   * any read. Stopping the wait (by timeout or `signal`) does not stop the
   * job.
   *
   * @throws {@link StowTimeoutError} when the job has not finished within
   * `timeoutMs`.
   * @throws {@link StowAbortError} when `signal` aborts.
   */
  async waitForImport(jobId: string, options?: WaitForImportOptions): Promise<ImportJob> {
    const pollIntervalMs = options?.pollIntervalMs ?? 3_000;
    const timeoutMs = options?.timeoutMs ?? 1_800_000;
    assertTimeoutMs('pollIntervalMs', pollIntervalMs);
    assertTimeoutMs('timeoutMs', timeoutMs);
    const signal = options?.signal;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = await this.getImport(jobId, { signal });
      if (FINISHED_IMPORT_STATUSES.has(job.status)) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new StowTimeoutError(
          `Import job ${jobId} did not finish within ${String(timeoutMs)} ms ` +
            `(${job.status}, ${String(job.processedRows)} of ${String(job.totalRows)} rows processed). ` +
            'It carries on: wait again or check it later.',
        );
      }
      await sleep(Math.min(pollIntervalMs, remaining), signal);
    }
  }

  /**
   * Add, remove or set a member's balance and push the wallet update.
   *
   * Pass exactly one of `delta` (relative, clamped at 0) or `value`
   * (absolute). The call always carries an `Idempotency-Key` (yours, or one
   * the SDK generates), so a retry can never apply the change twice.
   *
   * A refusal that sends the customer a wallet notice is stored against the
   * key too, so a retry with the same key replays the refusal without a
   * second notice. Try again later with a new key.
   *
   * @throws {@link BadRequestError} for a pass type with no balance
   * (`BALANCE_NOT_ADJUSTABLE`) or an invalid amount.
   * @throws {@link ConflictError} when the member is not active or a stamp
   * card is full (`STAMP_CARD_FULL`).
   *
   * @example
   * ```ts
   * const { current } = await stow.members.adjustPoints(
   *   memberId,
   *   { delta: 10, changeMessage: 'Thanks for visiting!' },
   *   { idempotencyKey: `order-${orderId}` },
   * );
   * ```
   */
  adjustPoints(
    memberId: string,
    params: AdjustPointsParams,
    options?: IdempotentRequestOptions,
  ): ApiPromise<BalanceChangeResult> {
    return this.#transport.request(() => {
      const hasDelta = params.delta !== undefined;
      const hasValue = params.value !== undefined;
      if (hasDelta === hasValue) {
        throw new TypeError('Pass exactly one of delta or value.');
      }
      for (const [name, amount] of [
        ['delta', params.delta],
        ['value', params.value],
      ] as const) {
        if (amount !== undefined && !Number.isInteger(amount)) {
          throw new TypeError(`${name} must be an integer.`);
        }
      }
      return {
        method: 'PATCH',
        path: `${BASE}/${segment('memberId', memberId)}/points`,
        body: pick(params, ['delta', 'value', 'changeMessage']),
        idempotent: true,
        idempotencyKey: Transport.idempotencyKey(options),
        options,
      };
    });
  }

  /**
   * Redeem the member's reward and push the pass update.
   *
   * A stamp card needs a full card and resets to 0. A points or tiered
   * program with a reward target deducts the target and keeps the rest.
   * Idempotent through an `Idempotency-Key`, like {@link Members.adjustPoints}.
   * A refusal (such as `REDEEM_NOT_ELIGIBLE`, which shows the customer a
   * wallet notice) is stored against the key, so a retry with the same key
   * replays it without a second notice. Redeem again later with a new key.
   *
   * @throws {@link BadRequestError} when the pass has no reward to redeem
   * (`REDEEM_NOT_AVAILABLE`).
   * @throws {@link ConflictError} when the balance has not reached the reward
   * (`REDEEM_NOT_ELIGIBLE`; `error.details` holds `current` and `goal`) or
   * the member is not active.
   */
  redeemReward(
    memberId: string,
    params?: RedeemRewardParams,
    options?: IdempotentRequestOptions,
  ): ApiPromise<BalanceChangeResult> {
    return this.#transport.request(() => ({
      method: 'POST',
      path: `${BASE}/${segment('memberId', memberId)}/redeem`,
      body: pick(params ?? {}, ['changeMessage']),
      idempotent: true,
      idempotencyKey: Transport.idempotencyKey(options),
      options,
    }));
  }

  /**
   * Set a member to `active`, `voided` or `expired` and push the pass update.
   * A voided or expired member's wallet pass shows as no longer valid (Apple
   * Wallet marks it void, Google Wallet sets it inactive or expired); setting
   * `active` again restores the normal pass. Google Wallet is updated only
   * when the customer saved the pass there.
   * Setting the status the member already has resolves with
   * `unchanged: true`. Idempotent through an `Idempotency-Key`.
   *
   * @throws {@link ConflictError} when another request changed the status in
   * the meantime: reload the member and decide again.
   */
  updateStatus(
    memberId: string,
    params: UpdateMemberStatusParams,
    options?: IdempotentRequestOptions,
  ): ApiPromise<UpdateMemberStatusResult> {
    return this.#transport.request(() => ({
      method: 'PATCH',
      path: `${BASE}/${segment('memberId', memberId)}/status`,
      body: pick(params, ['status', 'reason']),
      idempotent: true,
      idempotencyKey: Transport.idempotencyKey(options),
      options,
    }));
  }

  /**
   * Rebuild the member's pass from its current state, without changing any
   * balance, and push it to every wallet it is installed in: to heal a wallet
   * that missed an update, or to send a message.
   *
   * Every push is visible: the lock screen shows your `changeMessage`, or the
   * program's manual-push message when you send none. The SDK therefore never
   * retries a push, not after a network error, a 5xx or even a 429, since a
   * repeat could alert the customer twice. `maxRetries` cannot change this.
   *
   * @throws {@link ConflictError} when the member is not active or has no
   * installed wallet pass yet.
   */
  pushPass(memberId: string, params?: PushPassParams, options?: RequestOptions): ApiPromise<PushPassResult> {
    return this.#transport.request(() => ({
      method: 'POST',
      path: `${BASE}/${segment('memberId', memberId)}/push`,
      body: pick(params ?? {}, ['changeMessage']),
      idempotent: false,
      neverRetry: true,
      options,
    }));
  }

  /**
   * The member's wallet pass timeline, newest first (`pass_built`,
   * `device_registered`, `push_sent`, …).
   */
  listEvents(
    memberId: string,
    params?: ListMemberEventsParams,
    options?: RequestOptions,
  ): ApiPromise<MemberEventList> {
    return this.#transport.request(() => ({
      method: 'GET',
      path: `${BASE}/${segment('memberId', memberId)}/events`,
      query: { limit: params?.limit },
      idempotent: true,
      options,
    }));
  }

  /**
   * The member's ledger of balance-affecting actions, newest first, with
   * before and after balances and tier movement.
   */
  listTransactions(
    memberId: string,
    params?: PageParams,
    options?: RequestOptions,
  ): PagePromise<MemberTransaction> {
    return this.#transport.list(
      (page) => ({
        method: 'GET',
        path: `${BASE}/${segment('memberId', memberId)}/transactions`,
        query: { page, pageSize: params?.pageSize },
        idempotent: true,
        options,
      }),
      params?.page,
    );
  }
}

/** Copy only the named keys, dropping undefined values, so unknown fields never reach the API. */
function pick(source: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function tagList(tags: readonly string[]): string[] {
  if (!Array.isArray(tags) || tags.length === 0 || !tags.every((tag) => typeof tag === 'string')) {
    throw new TypeError('tags must be a non-empty array of strings.');
  }
  return [...tags];
}

/** A multipart CSV upload, never retried after a network error or 5xx (a 429 still is). */
function csvUpload(
  path: string,
  params: ImportMembersParams,
  options: RequestOptions | undefined,
): RequestSpec {
  const form = new FormData();
  form.append('programId', params.programId);
  form.append('file', toCsvBlob(params.file), params.filename ?? fileName(params.file) ?? 'members.csv');
  return { method: 'POST', path, form, idempotent: false, options };
}

/** The CSV as a `text/csv` part: the API refuses an upload typed otherwise (a bare Blob is `application/octet-stream`). */
function toCsvBlob(file: CsvFile): Blob {
  if (
    typeof file === 'string' ||
    file instanceof Uint8Array ||
    file instanceof ArrayBuffer ||
    file instanceof Blob
  ) {
    return new Blob([file], { type: 'text/csv' });
  }
  throw new TypeError('file must be a string, Uint8Array, ArrayBuffer or Blob.');
}

function fileName(file: CsvFile): string | undefined {
  return typeof File !== 'undefined' && file instanceof File && file.name !== '' ? file.name : undefined;
}
