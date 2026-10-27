// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed webhook payloads. Every delivery is a CloudEvents-flavoured envelope;
 * narrow it with a `switch` on {@link WebhookEnvelope.event}.
 */
import type { PassUpdateReport } from '../models.js';

/**
 * The envelope Stow Cards POSTs to your endpoint. Dedupe on `eventId`, which
 * is stable across retries and replays; treat unknown fields as additive.
 */
export interface WebhookEnvelope<TEvent extends string = string, TData = Record<string, unknown>> {
  specversion: '1.0';
  /** Same as `eventId`. */
  id: string;
  /** CloudEvents type, e.g. `cards.stow.points.changed`. */
  type: string;
  time: string;
  /** The event name, e.g. `points.changed`. */
  event: TEvent;
  /** Stable across retries and replays: your dedupe key. */
  eventId: string;
  occurredAt: string;
  /** Your merchant id. */
  tenantId: string;
  sourceService?: string;
  data: TData;
}

/** Data of `member.created`. */
export interface MemberCreatedEventData {
  memberId: string;
  /** The Member ID. Absent only for members enrolled before Member IDs existed. */
  memberCode?: string;
  programId: string;
  merchantId: string;
  email: string;
  firstName: string;
  lastName: string;
  /** Enrolment channel: public page, console, API or import. */
  source?: string;
  attribution?: Record<string, unknown>;
  passIssuance?: { apple: boolean; google: boolean };
  [key: string]: unknown;
}

/** Data of `points.changed`. */
export interface PointsChangedEventData {
  memberId: string;
  /** The Member ID. Absent only for members enrolled before Member IDs existed. */
  memberCode?: string;
  programId: string;
  merchantId: string;
  /** The `fieldValues` key that changed. */
  field: string;
  previous: number;
  current: number;
  delta: number;
  /** Tiered programs only. */
  tier?: string;
  previousTier?: string;
  tierUpgraded?: boolean;
  changeMessage?: string;
  passUpdate?: PassUpdateReport;
  [key: string]: unknown;
}

/** Data of `reward.redeemed`. */
export interface RewardRedeemedEventData {
  memberId: string;
  /** The Member ID. Absent only for members enrolled before Member IDs existed. */
  memberCode?: string;
  programId: string;
  merchantId: string;
  field: string;
  previous: number;
  /** Balance after the redemption. */
  current: number;
  /** The stamp goal or points target the redemption took. */
  goal: number;
  changeMessage?: string;
  passUpdate?: PassUpdateReport;
  [key: string]: unknown;
}

/** Data of `pass.updated`: a rebuilt pass was pushed to the member's wallets. */
export interface PassUpdatedEventData {
  memberId: string;
  /** The Member ID. Absent only for members enrolled before Member IDs existed. */
  memberCode?: string;
  serialNumber: string;
  programId: string;
  /** Timestamp of the new pass version. */
  lastUpdateTag: string;
  /** Apple devices that accepted the push. */
  devicesNotified: number;
  /** Whether the Google Wallet pass was updated. */
  googlePatched: boolean;
  /** Whether the update came from a reward redemption. */
  redeem: boolean;
  [key: string]: unknown;
}

/** Data of `pass.installed` and `pass.removed`. */
export interface PassLifecycleEventData {
  memberId: string;
  /** The Member ID. Absent only for members enrolled before Member IDs existed. */
  memberCode?: string;
  serialNumber: string;
  programId: string;
  platform: 'apple' | 'google';
  [key: string]: unknown;
}

/** Data of events whose payload is not yet specified in detail. */
export type GenericEventData = Record<string, unknown>;

export type MemberCreatedEvent = WebhookEnvelope<'member.created', MemberCreatedEventData>;
export type MemberUpdatedEvent = WebhookEnvelope<'member.updated', GenericEventData>;
export type PointsChangedEvent = WebhookEnvelope<'points.changed', PointsChangedEventData>;
export type RewardRedeemedEvent = WebhookEnvelope<'reward.redeemed', RewardRedeemedEventData>;
export type PassCreatedEvent = WebhookEnvelope<'pass.created', GenericEventData>;
export type PassInstalledEvent = WebhookEnvelope<'pass.installed', PassLifecycleEventData>;
export type PassUpdatedEvent = WebhookEnvelope<'pass.updated', PassUpdatedEventData>;
export type PassRemovedEvent = WebhookEnvelope<'pass.removed', PassLifecycleEventData>;
export type PassScannedEvent = WebhookEnvelope<'pass.scanned', GenericEventData>;
export type CampaignSentEvent = WebhookEnvelope<'campaign.sent', GenericEventData>;
export type BatchCompletedEvent = WebhookEnvelope<'batch.completed', GenericEventData>;
export type BatchFailedEvent = WebhookEnvelope<'batch.failed', GenericEventData>;

/**
 * Any real event Stow Cards delivers today. New event types can be added at
 * any time, so keep a `default` branch when you `switch` on `event`. Test
 * deliveries are a {@link WebhookTestEvent}: rule them out first with
 * {@link isWebhookTestEvent}.
 */
export type StowWebhookEvent =
  | MemberCreatedEvent
  | MemberUpdatedEvent
  | PointsChangedEvent
  | RewardRedeemedEvent
  | PassCreatedEvent
  | PassInstalledEvent
  | PassUpdatedEvent
  | PassRemovedEvent
  | PassScannedEvent
  | CampaignSentEvent
  | BatchCompletedEvent
  | BatchFailedEvent;

/** The data of a test delivery queued by {@link Webhooks.test}. */
export interface WebhookTestData {
  test: true;
  subscriptionId: string;
  /** When the test was queued. */
  sentAt: string;
}

/**
 * A test delivery: it carries one of the subscription's event names but only
 * {@link WebhookTestData}, never real event fields.
 */
export type WebhookTestEvent = WebhookEnvelope<StowWebhookEvent['event'], WebhookTestData>;
