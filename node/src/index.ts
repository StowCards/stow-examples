// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Official Node.js SDK for the Stow Cards API.
 *
 * @packageDocumentation
 */

export {
  StowClient,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type AppInfo,
  type StowClientOptions,
} from './client.js';
export { VERSION } from './version.js';

export { Programs } from './resources/programs.js';
export { Members } from './resources/members.js';
export { Webhooks } from './resources/webhooks.js';

export { ApiPromise, type RateLimitInfo, type ResponseMeta, type WithResponse } from './core/api-promise.js';
export { Page, PagePromise, type PageData } from './core/pagination.js';
export type { IdempotentRequestOptions, RequestOptions } from './core/transport.js';
export type { LogLevel, Logger } from './core/logger.js';

export {
  StowError,
  StowApiError,
  BadRequestError,
  AuthenticationError,
  PaymentRequiredError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  RateLimitError,
  InternalServerError,
  StowConnectionError,
  StowTimeoutError,
  StowAbortError,
  WebhookVerificationError,
  type StowApiErrorInit,
} from './core/errors.js';

export {
  constructWebhookEvent,
  verifyWebhookSignature,
  isWebhookTestEvent,
  generateWebhookTestHeaders,
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SUBSCRIPTION_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type VerifyWebhookParams,
  type WebhookHeaders,
  type WebhookTestHeadersParams,
} from './webhooks/verify.js';
export type * from './webhooks/events.js';

export { parseMemberBarcode, type ParseMemberBarcodeOptions } from './barcode.js';

export type * from './models.js';
