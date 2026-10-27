// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Webhook signature verification.
 *
 * Stow Cards signs each delivery with
 * `sha256=` + hex(HMAC-SHA256(secret, `${X-Stow-Webhook-Timestamp}.${rawBody}`)).
 * Checking the timestamp as well protects against replayed deliveries.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookVerificationError, isRecord } from '../core/errors.js';
import type { StowWebhookEvent, WebhookTestEvent } from './events.js';

/** Header carrying the delivery's signature. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-stow-webhook-signature';
/** Header carrying the signed ISO-8601 timestamp. */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-stow-webhook-timestamp';
/** Header carrying the event name. */
export const WEBHOOK_EVENT_HEADER = 'x-stow-webhook-event';
/** Header carrying the subscription id. */
export const WEBHOOK_SUBSCRIPTION_HEADER = 'x-stow-webhook-subscription';
/** Default accepted clock difference: 5 minutes. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

const SIGNATURE_PREFIX = 'sha256=';
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/i;

/** Incoming request headers: a `Headers` object or Node's `IncomingHttpHeaders`. */
export type WebhookHeaders = Headers | Record<string, string | readonly string[] | undefined>;

/** Input of {@link verifyWebhookSignature} and {@link constructWebhookEvent}. */
export interface VerifyWebhookParams {
  /**
   * The request body **exactly as received** (a string or the raw bytes).
   * Never pass a re-serialised object: key order and whitespace change the
   * signature.
   */
  payload: string | Uint8Array;
  /** The request headers. */
  headers: WebhookHeaders;
  /**
   * The subscription's signing secret. While rotating, pass the new and the
   * old secret (new first), so retries already signed with the old one are
   * still accepted.
   */
  secret: string | readonly string[];
  /**
   * Maximum accepted difference between the signed timestamp and now, in
   * milliseconds. Defaults to 5 minutes.
   */
  toleranceMs?: number | undefined;
  /** The current time in milliseconds since the epoch, for tests. */
  now?: number | undefined;
}

/**
 * Verify a webhook delivery's signature and timestamp.
 *
 * @throws {@link WebhookVerificationError} when the delivery is unsigned,
 * tampered with, signed with another secret or outside the tolerance.
 * Answer such a request with a 400.
 */
export function verifyWebhookSignature(params: VerifyWebhookParams): void {
  const secrets = normaliseSecrets(params.secret);
  const payload = toBytes(params.payload);
  const timestamp = readHeader(params.headers, WEBHOOK_TIMESTAMP_HEADER);
  const signature = readHeader(params.headers, WEBHOOK_SIGNATURE_HEADER);

  if (timestamp === undefined) {
    throw new WebhookVerificationError(`Missing ${WEBHOOK_TIMESTAMP_HEADER} header.`);
  }
  if (signature === undefined) {
    throw new WebhookVerificationError(
      `Missing ${WEBHOOK_SIGNATURE_HEADER} header. Is a secret set on the subscription?`,
    );
  }
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new WebhookVerificationError('Malformed signature header.');
  }

  const signedAt = Date.parse(timestamp);
  if (Number.isNaN(signedAt)) {
    throw new WebhookVerificationError('Malformed timestamp header.');
  }
  const tolerance = params.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  // Finite only: Infinity or NaN would silently switch replay protection off.
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new TypeError('toleranceMs must be a finite, non-negative number of milliseconds.');
  }
  const now = params.now ?? Date.now();
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('now must be a finite number of milliseconds since the epoch.');
  }
  if (Math.abs(now - signedAt) > tolerance) {
    throw new WebhookVerificationError('Timestamp is outside the tolerance; possible replay.');
  }

  const received = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'hex');
  for (const secret of secrets) {
    const expected = hmac(secret, timestamp, payload);
    if (expected.length === received.length && timingSafeEqual(expected, received)) return;
  }
  throw new WebhookVerificationError('Signature does not match.');
}

/**
 * Verify a webhook delivery and parse it into a typed event.
 *
 * @example
 * ```ts
 * // Express: keep the raw body for this route.
 * app.post('/stow/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
 *   let event;
 *   try {
 *     event = constructWebhookEvent({
 *       payload: req.body,
 *       headers: req.headers,
 *       secret: process.env.STOW_WEBHOOK_SECRET!,
 *     });
 *   } catch {
 *     return res.sendStatus(400);
 *   }
 *   if (isWebhookTestEvent(event)) return res.sendStatus(204);
 *   switch (event.event) {
 *     case 'points.changed':
 *       console.log(event.data.memberCode, event.data.current);
 *       break;
 *     default:
 *       break;
 *   }
 *   res.sendStatus(204);
 * });
 * ```
 *
 * Deliveries queued by {@link Webhooks.test} carry only test data: check
 * {@link isWebhookTestEvent} before reading event fields.
 *
 * @throws {@link WebhookVerificationError} when verification fails or the
 * body is not a JSON event envelope.
 */
export function constructWebhookEvent(params: VerifyWebhookParams): StowWebhookEvent | WebhookTestEvent {
  verifyWebhookSignature(params);
  const text =
    typeof params.payload === 'string' ? params.payload : Buffer.from(params.payload).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WebhookVerificationError('Payload is not valid JSON.', { cause: error });
  }
  if (
    !isRecord(parsed) ||
    typeof parsed['event'] !== 'string' ||
    typeof parsed['eventId'] !== 'string' ||
    !isRecord(parsed['data'])
  ) {
    throw new WebhookVerificationError('Payload is not a Stow Cards event envelope.');
  }
  return parsed as unknown as StowWebhookEvent | WebhookTestEvent;
}

/**
 * Whether an event is a test delivery queued by {@link Webhooks.test}. Its
 * `data` is only `{ test: true, subscriptionId, sentAt }`, whatever its event
 * name, so acknowledge it without reading event fields.
 */
export function isWebhookTestEvent(event: StowWebhookEvent | WebhookTestEvent): event is WebhookTestEvent {
  return (event.data as { test?: unknown }).test === true;
}

/** Input of {@link generateWebhookTestHeaders}. */
export interface WebhookTestHeadersParams {
  /** The exact body your test will send. */
  payload: string | Uint8Array;
  /** The secret your handler verifies with. */
  secret: string;
  /** Signed timestamp. Defaults to now. */
  timestamp?: Date | undefined;
  /** Event name for `X-Stow-Webhook-Event`. Defaults to `member.created`. */
  event?: string | undefined;
}

/**
 * Build the headers of a correctly signed delivery, for testing your webhook
 * handler without a live subscription.
 */
export function generateWebhookTestHeaders(params: WebhookTestHeadersParams): Record<string, string> {
  const [secret] = normaliseSecrets(params.secret);
  const timestamp = (params.timestamp ?? new Date()).toISOString();
  const signature = hmac(secret, timestamp, toBytes(params.payload)).toString('hex');
  return {
    'content-type': 'application/json',
    [WEBHOOK_EVENT_HEADER]: params.event ?? 'member.created',
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_SIGNATURE_HEADER]: `${SIGNATURE_PREFIX}${signature}`,
  };
}

function hmac(secret: string, timestamp: string, payload: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
}

function normaliseSecrets(secret: string | readonly string[]): [string, ...string[]] {
  const candidates: readonly unknown[] =
    typeof secret === 'string' ? [secret] : Array.isArray(secret) ? secret : [];
  const secrets = candidates.filter((value): value is string => typeof value === 'string' && value !== '');
  const [first, ...rest] = secrets;
  if (first === undefined || secrets.length !== candidates.length) {
    throw new TypeError('secret must be a non-empty string or a non-empty array of them.');
  }
  return [first, ...rest];
}

function toBytes(payload: unknown): Uint8Array {
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  if (payload instanceof Uint8Array) return payload;
  throw new TypeError(
    'payload must be the raw request body as a string or Buffer. A parsed object cannot be verified: ' +
      'read the raw body (for example express.raw({ type: "application/json" })).',
  );
}

function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  let value: string | readonly string[] | null | undefined;
  if (headers instanceof Headers) {
    value = headers.get(name);
  } else {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
    value = key === undefined ? undefined : headers[key];
  }
  const first =
    typeof value === 'string' ? value : Array.isArray(value) ? (value[0] as string | undefined) : undefined;
  const trimmed = first?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
