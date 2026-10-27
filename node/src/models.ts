// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Data models of the Stow Cards API (OpenAPI spec 1.0.14).
 *
 * Responses may gain new fields at any time; treat unknown fields as
 * additive. Timestamps are ISO-8601 strings in UTC.
 */

// ─── Programs ────────────────────────────────────────────────────────────────

/** Program lifecycle status. Members can be enrolled into any non-archived program. */
export type ProgramStatus = 'draft' | 'active' | 'paused' | 'archived';

/**
 * A pass program, as designed in the web console's Pass Designer.
 *
 * Programs are raw records keyed by **`_id`** (members use `id`). Designer
 * fields beyond the ones typed here are present and may grow.
 */
export interface Program {
  /** Program id. Pass it as `programId` when enrolling members. */
  _id: string;
  name: string;
  slug?: string;
  status: ProgramStatus;
  programType?: string;
  /**
   * The pass type shown to merchants and customers: `loyalty`, `membership`,
   * `coupon`, `giftCard`, `eventTicket`, and so on.
   */
  productType?: string;
  /** `points` or `stamps` for loyalty programs. */
  loyaltyStyle?: string;
  /** The `member.fieldValues` key this program's balance lives under. */
  balanceKey?: string;
  /** Stamps needed for a reward (stamp programs). */
  stampGoal?: number;
  pointsStep?: number;
  /** ISO 4217 code a gift card's balance is held in, e.g. `GBP`. */
  currency?: string | null;
  fields?: {
    /** The balance unit label, e.g. `POINTS`; lower-cased, it keys `member.fieldValues`. */
    primaryLabel?: string;
    [key: string]: unknown;
  };
  /** How the pass barcode is drawn. Pass `valueTemplate` to {@link parseMemberBarcode}. */
  barcode?: {
    /** Symbology, e.g. `QR`. */
    format?: string;
    /** What the barcode encodes, e.g. `MEMBER-{{memberCode}}`. */
    valueTemplate?: string;
    showAltText?: boolean;
    altText?: string;
    [key: string]: unknown;
  };
  createdAt?: string;
  [key: string]: unknown;
}

/** Compact program snapshot embedded in member responses. */
export interface ProgramSummary {
  id: string;
  name: string;
  programType?: string;
  loyaltyStyle?: string;
  /** Internal wallet rendering style. Do not display it. */
  passType?: string;
  balanceKey?: string;
  stampGoal?: number;
  pointsStep?: number;
  /** The program's resolved ISO 4217 currency, when one resolves. */
  currency?: string;
  [key: string]: unknown;
}

// ─── Members ─────────────────────────────────────────────────────────────────

/** Member status. Only `active` members can earn, redeem or receive pushes. */
export type MemberStatus = 'active' | 'voided' | 'expired';

/**
 * Wallet pass stage: `created` (not yet added to a wallet), `installed`,
 * `in_use` (its balance changed or a reward was redeemed; it stays `in_use`
 * until the pass leaves every wallet) or `removed`.
 */
export type PassStatus = 'created' | 'installed' | 'in_use' | 'removed';

/**
 * Whether a real wallet credential signed the pass (`real`) or the platform
 * ran without one (`stub`). Read this field; never infer it from a URL.
 */
export type WalletMode = 'real' | 'stub';

/** Apple Wallet state of a member's pass. */
export interface AppleWalletPass {
  /** Absolute `.pkpass` download URL: the "Add to Apple Wallet" link. */
  passUrl?: string;
  installed?: boolean;
  installedAt?: string;
  lastUpdateTag?: string;
  mode?: WalletMode;
}

/** Google Wallet state of a member's pass. */
export interface GoogleWalletPass {
  /** The "Save to Google Wallet" link. */
  saveUrl?: string;
  installed?: boolean;
  installedAt?: string;
  mode?: WalletMode;
}

/** How a member joined. Enrolments through the API and the console are `staff`. */
export type EnrollmentSource = 'qr' | 'email' | 'sms' | 'api' | 'staff' | 'web';

/** The form, download page, campaign, QR code and UTM details recorded when a member joined. */
export interface EnrollmentAttribution {
  /** The hosted sign-up form the member used. */
  formId?: string;
  /** The pass download page the member used. */
  downloadPageId?: string;
  /** The campaign that brought the member in. */
  campaignId?: string;
  /** Which QR code the member scanned. */
  qrSource?: string;
  /** `utm_source` of the sign-up link. */
  utmSource?: string;
  /** `utm_medium` of the sign-up link. */
  utmMedium?: string;
  /** `utm_campaign` of the sign-up link. */
  utmCampaign?: string;
  /** `utm_term` of the sign-up link. */
  utmTerm?: string;
  /** `utm_content` of the sign-up link. */
  utmContent?: string;
  /** The language the sign-up page was shown in. */
  locale?: string;
  /** The acquisition channel recorded for the sign-up. */
  acquisitionChannel?: string;
}

/**
 * A customer enrolled in a program, holding an Apple and/or Google Wallet pass.
 * A field the member has no value for is absent.
 */
export interface Member {
  /** Member UUID. Use it in API paths; never show it to people. */
  id: string;
  programId: string;
  /** Internal wallet serial. Never show it to staff or customers. */
  serialNumber: string;
  /**
   * The human-facing **"Member ID"** (10 characters, e.g. `7K2P9QX4M8`). It is
   * what the pass barcode encodes and the only member identifier that should
   * leave your system. Absent only for members enrolled before Member IDs
   * existed.
   */
  memberCode?: string;
  firstName: string;
  lastName: string;
  email: string;
  /** The phone number as the customer gave it. */
  phone?: string;
  /** Date of birth (`YYYY-MM-DD`), when the program's sign-up form asks for it. */
  birthday?: string;
  /** The customer's answer to the sign-up form's marketing opt-in box. */
  marketingOptIn?: boolean;
  /** When that consent was given (proof of consent). */
  marketingOptInAt?: string;
  /** Your own id for the customer (for example a POS customer id). */
  externalId?: string;
  /** Answers to the custom questions on a hosted sign-up form, keyed by question. */
  formFields?: Record<string, unknown>;
  /** Up to 25 normalised tags. */
  tags?: string[];
  status: MemberStatus;
  expiresAt?: string;
  passStatus?: PassStatus;
  /**
   * Values printed on the pass, keyed by field. The balance sits under the
   * program's `balanceKey` (or its lower-cased primary label: `points`,
   * `stamps`, …). A balance can arrive as a numeric string such as `"0"`, so
   * read it with `Number(...)`; other fields hold text.
   */
  fieldValues?: Record<string, number | string>;
  /** Current tier name (tiered programs only). */
  tier?: string;
  apple?: AppleWalletPass;
  google?: GoogleWalletPass;
  /** How the member joined. */
  enrollmentSource?: EnrollmentSource;
  /** The campaign, form or UTM details recorded when the member joined. */
  enrollmentAttribution?: EnrollmentAttribution;
  createdAt: string;
  updatedAt?: string;
  lastUsedAt?: string;
}

/** A member with a snapshot of its program, as returned by lists. */
export interface MemberWithProgram extends Member {
  /** The member's program, or `null` (or absent) when the program has been deleted. */
  program?: ProgramSummary | null;
}

/** The full member, as returned by {@link Members.get}. */
export interface MemberDetail extends MemberWithProgram {
  /** The member's program, or `null` when the program has been deleted. */
  program: ProgramSummary | null;
  /** Registered wallet devices. */
  deviceCount: number;
  /** Lifetime reward redemptions. */
  redeemedCount: number;
}

/**
 * Which wallet passes were issued for a new member (from API 1.0.14). A
 * `false` flag means that wallet's pass could not be built: the member is
 * saved, but its link for that wallet (`apple.passUrl` or `google.saveUrl`)
 * is missing.
 */
export interface PassIssuance {
  /** Whether the Apple Wallet pass was built (`apple.passUrl` is present). */
  apple: boolean;
  /** Whether the Google Wallet pass was built (`google.saveUrl` is present). */
  google: boolean;
}

/**
 * Result of {@link Members.enroll}: the full member (every field it holds), its
 * wallet pass links and what its barcode encodes.
 */
export interface EnrolledMember extends Member {
  /** What the pass barcode encodes, when it can be resolved without building the pass. */
  barcode?: {
    value: string;
    /** Text printed under the barcode, unless the program hides it. */
    altText?: string;
  };
  /** Apple Wallet pass. `passUrl` is missing only when the Apple pass could not be built. */
  apple: AppleWalletPass & { passId?: string; installed: boolean };
  /** Google Wallet pass. `saveUrl` is missing only when the Google pass could not be built. */
  google: GoogleWalletPass & { objectId?: string; installed: boolean };
  /**
   * `true` when a member with this email already existed in the program and
   * was returned instead (HTTP 200, nothing created). Treat it as success.
   */
  deduped?: true;
  /**
   * Which wallet passes the member has (from API 1.0.14), on new and deduped
   * members alike. A `false` flag means that wallet's pass could not be
   * built: the member is saved, but its link for that wallet is missing.
   * On a deduped member it reflects the links the member has stored: a
   * deduped answer that arrives while the first request is still building
   * the passes waits for them (up to 20 seconds) before answering.
   */
  passIssuance?: PassIssuance;
}

/** Result of a tag change. */
export interface TaggedMember extends Member {
  /**
   * `true` when the change was a no-op (all tags already present or absent).
   * It is also `true` when the SDK retried a request whose first attempt had
   * already applied the change (`response.attempts > 1`), so do not hang side
   * effects on it.
   */
  unchanged?: true;
}

/** Parameters of {@link Members.enroll}. */
export interface EnrollMemberParams {
  /** The program's `_id`. It must belong to your merchant and not be archived. */
  programId: string;
  /** 1 to 100 characters. */
  firstName: string;
  /** 1 to 100 characters. */
  lastName: string;
  /** Up to 255 characters. Enrolment dedupes on `(programId, email)`. */
  email: string;
  /** Up to 50 characters. */
  phone?: string | undefined;
  /** Seeds the program's balance, 0 to 1,000,000. */
  initialPoints?: number | undefined;
}

/** Wallet filter of {@link Members.list}. */
export type WalletFilter = 'installed' | 'not_installed' | 'apple' | 'google';

/**
 * Parameters of {@link Members.list}. Filters combine: a member must match
 * all of them; a list of programs or tags matches any of its values.
 */
export interface ListMembersParams {
  /** Only members of this program, or of any of these programs. */
  programId?: string | readonly string[] | undefined;
  /**
   * Search first name, last name, email or phone, or the start of a
   * `memberCode`. With several words, each word must match one of these.
   */
  q?: string | undefined;
  /** Only members with this email address (exact, any letter case). */
  email?: string | undefined;
  /**
   * Only members with this phone number, matched by its digits (at least 6)
   * whatever the formatting: `+44 7700 900123` finds `447700900123`.
   */
  phone?: string | undefined;
  /** Only members with this status. */
  status?: MemberStatus | undefined;
  /** Only members whose wallet pass is at this stage. */
  passStatus?: PassStatus | undefined;
  /** Only members carrying this tag, or any of these tags. */
  tag?: string | readonly string[] | undefined;
  /**
   * `installed` (in Apple or Google Wallet), `not_installed` (in neither),
   * `apple` or `google`.
   */
  wallet?: WalletFilter | undefined;
  /** One-based page number. Defaults to 1. */
  page?: number | undefined;
  /** Items per page, 1 to 100. Defaults to 25. */
  pageSize?: number | undefined;
}

/** Narrows {@link Members.findByEmail} and {@link Members.findByPhone}. */
export interface FindMembersParams {
  /** Only members of this program, or of any of these programs. */
  programId?: string | readonly string[] | undefined;
  /** Only members with this status. */
  status?: MemberStatus | undefined;
  /** One-based page number. Defaults to 1. */
  page?: number | undefined;
  /** Items per page, 1 to 100. Defaults to 25. */
  pageSize?: number | undefined;
}

/** Outcome of one CSV row in {@link Members.import}. */
export interface ImportedRow {
  id: string;
  email: string;
}

/** A row {@link Members.import} enrolled as a new member. */
export interface CreatedImportRow extends ImportedRow {
  /**
   * Which wallet passes were issued for this member (from API 1.0.14). A
   * `false` flag means that wallet's pass could not be built: the member is
   * saved, but its link for that wallet is missing.
   */
  passIssuance?: PassIssuance;
}

/** A CSV row that could not be imported. */
export interface FailedImportRow {
  /** One-based CSV line number, counting the header as line 1. */
  row: number;
  email?: string;
  error: string;
}

/** Result of {@link Members.import}. */
export interface ImportMembersResult {
  summary: {
    totalRows: number;
    created: number;
    deduped: number;
    failed: number;
    /**
     * Created rows with at least one wallet pass that could not be built (a
     * `false` flag in their `passIssuance`), from API 1.0.14. Those members
     * are saved, but a wallet link is missing.
     */
    partial?: number;
  };
  created: CreatedImportRow[];
  deduped: ImportedRow[];
  failed: FailedImportRow[];
}

/** The CSV file for {@link Members.import}: its text, its bytes, or a `Blob`/`File`. */
export type CsvFile = string | Uint8Array | ArrayBuffer | Blob;

/** Parameters of {@link Members.import}. */
export interface ImportMembersParams {
  /** The program's `_id`. */
  programId: string;
  /**
   * The CSV, at most 1 MB and 5,000 rows. Headers (any case, any order):
   * `firstName`, `lastName`, `email`, `phone`, `initialPoints`.
   */
  file: CsvFile;
  /** File name sent with the upload. Defaults to `members.csv`. */
  filename?: string | undefined;
}

/**
 * Where an import job is:
 *
 * - `queued`: waiting for the worker, which picks it up within seconds;
 * - `running`: enrolling rows, one at a time;
 * - `completed`: finished (rows can still have failed: read `failedRows`);
 * - `failed`: finished with failed rows and none created;
 * - `cancelled`: stopped before it finished.
 */
export type ImportJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A background CSV import, started by {@link Members.startImport}. The counts
 * are read when you fetch the job, so they grow while it runs.
 */
export interface ImportJob {
  /** The job's id. Webhook `batch.completed` and `batch.failed` events carry it as `data.batchJobId`. */
  id: string;
  /** The program the rows enrol into. */
  programId: string;
  /** Name of the uploaded file. */
  fileName: string;
  status: ImportJobStatus;
  /** Data rows in the file (the header not counted). */
  totalRows: number;
  /** Rows finished so far: `createdRows + dedupedRows + failedRows`. */
  processedRows: number;
  /** Rows enrolled as new members. */
  createdRows: number;
  /** Rows whose email was already enrolled in the program; nothing was created for them. */
  dedupedRows: number;
  /** Rows that could not be enrolled, including rows refused by validation at upload. */
  failedRows: number;
  /**
   * Created rows with at least one wallet pass that could not be built (a
   * `false` flag in their `passIssuance`). Those members are saved, but a
   * wallet link is missing.
   */
  partialRows: number;
  /** When the job was created (ISO 8601). */
  createdAt: string;
  /** When the worker started it (ISO 8601), or `null` while it is queued. */
  startedAt: string | null;
  /** When it finished (ISO 8601), or `null` until then. */
  completedAt: string | null;
}

/**
 * Outcome of one row of an import job: `pending` (not processed yet),
 * `created`, `deduped` (already enrolled) or `failed`.
 */
export type ImportJobRowStatus = 'pending' | 'created' | 'deduped' | 'failed';

/** One CSV row of an import job, from {@link Members.listImportRows}. */
export interface ImportJobRow {
  /** One-based CSV line number, counting the header as line 1. */
  rowNumber: number;
  status: ImportJobRowStatus;
  email?: string;
  /** The member's `id`, on `created` and `deduped` rows. */
  memberId?: string;
  /** Why the row failed, on `failed` rows. */
  error?: string;
  /**
   * Which wallet passes were issued, on `created` rows. A `false` flag means
   * that wallet's pass could not be built: the member is saved, but its link
   * for that wallet is missing.
   */
  passIssuance?: PassIssuance;
}

/** Parameters of {@link Members.listImportRows}. */
export interface ListImportRowsParams {
  /** Only rows with this outcome. */
  status?: ImportJobRowStatus | undefined;
  /** One-based page number. Defaults to 1. */
  page?: number | undefined;
  /** Rows per page, 1 to 100. Defaults to 50. */
  pageSize?: number | undefined;
}

/** Options of {@link Members.waitForImport}. */
export interface WaitForImportOptions {
  /** How often to fetch the job, in whole milliseconds. Defaults to 3,000. */
  pollIntervalMs?: number | undefined;
  /** How long to wait in all, in whole milliseconds. Defaults to 1,800,000 (30 minutes). */
  timeoutMs?: number | undefined;
  /** Stop waiting. Aborting rejects with a {@link StowAbortError}; the job carries on. */
  signal?: AbortSignal | undefined;
}

// ─── Points, rewards and status ──────────────────────────────────────────────

/**
 * Parameters of {@link Members.adjustPoints}: exactly one of `delta`
 * (relative) or `value` (absolute).
 */
export type AdjustPointsParams =
  | {
      /**
       * Relative change, -100,000 to 100,000; the balance is clamped at 0.
       * Stamp cards accept only `1` (add a stamp) or `-1` (correct one).
       */
      delta: number;
      value?: never;
      /** Shown on the customer's lock screen when the pass updates (up to 200 characters). */
      changeMessage?: string | undefined;
    }
  | {
      /** Absolute new balance, 0 to 1,000,000. */
      value: number;
      delta?: never;
      /** Shown on the customer's lock screen when the pass updates (up to 200 characters). */
      changeMessage?: string | undefined;
    };

/** Parameters of {@link Members.redeemReward}. */
export interface RedeemRewardParams {
  /** Shown on the customer's lock screen (up to 200 characters). */
  changeMessage?: string | undefined;
}

/** Parameters of {@link Members.updateStatus}. */
export interface UpdateMemberStatusParams {
  status: MemberStatus;
  /**
   * Optional audit note (up to 500 characters). It is kept in the audit trail
   * and the `member.updated` webhook, and never shown to the customer.
   */
  reason?: string | undefined;
}

/**
 * What happened to the wallet pass after a change. `null` when the pass
 * service did not confirm the update; the change itself is already saved.
 */
export type PassUpdateReport = {
  /** The pass serial (a UUID). Not the Member ID. */
  serialNumber?: string;
  /** Timestamp of the latest pass version. */
  lastUpdateTag?: string;
  /** `true` when the signed pass file was rebuilt (real mode only). */
  rebuilt?: boolean;
  apple?: {
    /** Apple devices that accepted the push. */
    devicesNotified?: number;
    /** Apple devices registered for this pass. */
    devicesAttempted?: number;
    mode?: WalletMode;
  };
  google?: {
    /** `true` when the Google Wallet pass was updated (saved passes only, real mode only). */
    objectPatched?: boolean;
    mode?: WalletMode;
  };
  [key: string]: unknown;
} | null;

/** Result of {@link Members.adjustPoints} and {@link Members.redeemReward}. */
export interface BalanceChangeResult {
  member: Member;
  /** Balance before the change. */
  previous: number;
  /** Balance after the change. */
  current: number;
  passUpdate: PassUpdateReport;
}

/** Result of a status change that took effect. */
export interface StatusChangeResult {
  member: Member;
  previous: MemberStatus;
  current: MemberStatus;
  passUpdate: PassUpdateReport;
}

/** Result of a status change to the status the member already had (a no-op). */
export interface UnchangedStatusResult extends Member {
  unchanged: true;
}

/** Result of {@link Members.updateStatus}: check `'unchanged' in result` first. */
export type UpdateMemberStatusResult = StatusChangeResult | UnchangedStatusResult;

/** Parameters of {@link Members.pushPass}. */
export interface PushPassParams {
  /**
   * Shown on the customer's lock screen (up to 200 characters). Omit it to
   * send the program's manual-push message.
   */
  changeMessage?: string | undefined;
}

/** Result of {@link Members.pushPass}. */
export interface PushPassResult {
  member: Member;
  passUpdate: PassUpdateReport;
}

// ─── Events and transactions ─────────────────────────────────────────────────

/** Outcome of a pass event. `skipped` marks the stub-mode "would have pushed" case. */
export type PassEventOutcome = 'success' | 'failure' | 'skipped';

/** One wallet pass lifecycle event. */
export interface MemberEvent {
  id: string;
  /**
   * `pass_built`, `device_registered`, `push_sent`, `google_object_patched`,
   * `reward_redeemed`, … (an open set).
   */
  eventType: string;
  /** `apple` or `google`, where applicable. */
  platform?: string;
  outcome: PassEventOutcome;
  payload?: Record<string, unknown>;
  createdAt: string;
}

/** Result of {@link Members.listEvents}. */
export interface MemberEventList {
  /** Newest first. */
  items: MemberEvent[];
}

/** Parameters of {@link Members.listEvents}. */
export interface ListMemberEventsParams {
  /** How many events to return, 1 to 500. Defaults to 50. */
  limit?: number | undefined;
}

/** One balance-affecting action in a member's ledger. */
export interface MemberTransaction {
  id: string;
  createdAt: string;
  memberId: string;
  memberCode?: string;
  programId?: string;
  programName?: string;
  /** What happened: `adjust`, `redeem`, `scan`, … */
  action: string;
  source?: string;
  channel?: string;
  readerId?: string;
  readerName?: string;
  locationId?: string;
  balanceKey?: string;
  balanceLabel?: string;
  delta?: number;
  balanceBefore?: number;
  balanceAfter?: number;
  note?: string;
  tierBefore?: string;
  tierAfter?: string;
  tierUpgraded?: boolean;
  actor?: {
    email?: string;
    scope?: string;
  };
  [key: string]: unknown;
}

/** Pagination parameters. */
export interface PageParams {
  /** One-based page number. Defaults to 1. */
  page?: number | undefined;
  /** Items per page, 1 to 100. Defaults to 25. */
  pageSize?: number | undefined;
}

/** Result of {@link Members.listTags}. */
export interface TagList {
  /** Distinct tags across your members, sorted alphabetically. */
  tags: string[];
}

// ─── Webhook subscriptions ───────────────────────────────────────────────────

/** Event types a webhook subscription can receive. */
export type WebhookEventType =
  | 'member.created'
  | 'member.updated'
  | 'points.changed'
  | 'reward.redeemed'
  | 'pass.created'
  | 'pass.installed'
  | 'pass.updated'
  | 'pass.removed'
  | 'pass.scanned'
  | 'campaign.sent'
  | 'batch.completed'
  | 'batch.failed';

/** A subscription's event filter: specific events, or `*` for all of them. */
export type WebhookEventFilter = WebhookEventType | '*';

/** Delivery retry settings of a subscription. */
export interface WebhookRetryPolicy {
  /** 1 to 5. Defaults to 3. */
  maxAttempts?: number;
  /** 100 to 10,000 ms between attempts. Defaults to 500. */
  backoffMs?: number;
  /** 500 to 30,000 ms per attempt. Defaults to 5,000. */
  timeoutMs?: number;
}

/** An outbound webhook subscription. The signing secret is never included. */
export interface WebhookSubscription {
  id: string;
  name: string;
  description?: string;
  url: string;
  events: WebhookEventFilter[];
  enabled: boolean;
  retryPolicy?: WebhookRetryPolicy;
  lastTriggeredAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** A subscription with its signing secret, returned only on create and rotation. */
export interface WebhookSubscriptionWithSecret extends WebhookSubscription {
  /** The signing secret. Store it now: it is not shown again. */
  secret: string;
}

/** Parameters of {@link Webhooks.create}. */
export interface CreateWebhookParams {
  /** Up to 200 characters. */
  name: string;
  /** Up to 1,000 characters. */
  description?: string | undefined;
  /** Your **https** endpoint, up to 2,048 characters. */
  url: string;
  /** Defaults to `['member.created']`. */
  events?: WebhookEventFilter[] | undefined;
  /** Defaults to `true`. */
  enabled?: boolean | undefined;
  /** Omit to have a strong secret generated (recommended). */
  secret?: string | undefined;
  retryPolicy?: WebhookRetryPolicy | undefined;
}

/** Parameters of {@link Webhooks.update}. Send at least one field. */
export interface UpdateWebhookParams {
  name?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  events?: WebhookEventFilter[] | undefined;
  enabled?: boolean | undefined;
  retryPolicy?: WebhookRetryPolicy | undefined;
}

/** Parameters of {@link Webhooks.list}. */
export interface ListWebhooksParams extends PageParams {
  /** Only enabled (`true`) or disabled (`false`) subscriptions. */
  enabled?: boolean | undefined;
}

/** Parameters of {@link Webhooks.listDeliveryLogs}. */
export interface ListDeliveryLogsParams extends PageParams {
  subscriptionId?: string | undefined;
  eventType?: string | undefined;
  /** Only successful (`true`) or failed (`false`) deliveries. */
  success?: boolean | undefined;
}

/** One logged delivery attempt. `payload` is PII-masked. */
export interface WebhookDeliveryLog {
  _id: string;
  subscriptionId: string;
  eventType: string;
  eventId: string;
  success: boolean;
  statusCode?: number;
  attempts?: number;
  responseTimeMs?: number;
  lastError?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  [key: string]: unknown;
}

/** Result of {@link Webhooks.test} and {@link Webhooks.replayDelivery}. */
export interface QueuedDelivery {
  queued: true;
  eventType: string;
  /** Stable across retries and replays: your dedupe key. */
  eventId: string;
}
