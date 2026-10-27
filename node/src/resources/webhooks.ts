// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import type { ApiPromise } from '../core/api-promise.js';
import type { PagePromise } from '../core/pagination.js';
import { segment } from '../core/path.js';
import type { RequestOptions, Transport } from '../core/transport.js';
import type {
  CreateWebhookParams,
  ListDeliveryLogsParams,
  ListWebhooksParams,
  QueuedDelivery,
  UpdateWebhookParams,
  WebhookDeliveryLog,
  WebhookSubscription,
  WebhookSubscriptionWithSecret,
} from '../models.js';

const BASE = '/merchants/me/webhooks';

/**
 * Manage outbound webhook subscriptions: Stow Cards POSTs signed JSON events
 * (`member.created`, `points.changed`, `reward.redeemed`, …) to your HTTPS
 * endpoint. Verify each delivery with {@link constructWebhookEvent}.
 *
 * Requires an API key with the merchant webhooks permissions.
 */
export class Webhooks {
  readonly #transport: Transport;

  // Private, so the declarations publish no constructor: use StowClient.
  private constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** @internal */
  static _create(transport: Transport): Webhooks {
    return new Webhooks(transport);
  }

  /** List subscriptions. Secrets are never included. */
  list(params?: ListWebhooksParams, options?: RequestOptions): PagePromise<WebhookSubscription> {
    return this.#transport.list(
      (page) => ({
        method: 'GET',
        path: BASE,
        query: { page, pageSize: params?.pageSize, enabled: params?.enabled },
        idempotent: true,
        options,
      }),
      params?.page,
    );
  }

  /**
   * Create a subscription. The response carries the signing `secret`, which
   * is shown only here and on {@link Webhooks.rotateSecret}: store it now.
   *
   * Not retried automatically on a network failure or 5xx, because a repeat
   * could create a second subscription.
   */
  create(params: CreateWebhookParams, options?: RequestOptions): ApiPromise<WebhookSubscriptionWithSecret> {
    return this.#transport.request(() => ({
      method: 'POST',
      path: BASE,
      body: params,
      idempotent: false,
      options,
    }));
  }

  /** Get one subscription. */
  get(subscriptionId: string, options?: RequestOptions): ApiPromise<WebhookSubscription> {
    return this.#transport.request(() => ({
      method: 'GET',
      path: `${BASE}/${segment('subscriptionId', subscriptionId)}`,
      idempotent: true,
      options,
    }));
  }

  /** Change any of a subscription's name, description, URL, events, enabled flag or retry policy. */
  update(
    subscriptionId: string,
    params: UpdateWebhookParams,
    options?: RequestOptions,
  ): ApiPromise<WebhookSubscription> {
    return this.#transport.request(() => ({
      method: 'PATCH',
      path: `${BASE}/${segment('subscriptionId', subscriptionId)}`,
      body: params,
      idempotent: true,
      options,
    }));
  }

  /**
   * Delete a subscription.
   *
   * Not retried automatically after a network error or 5xx: if the first
   * attempt had already deleted it, a repeat would answer 404 for a
   * subscription that is in fact gone.
   */
  delete(subscriptionId: string, options?: RequestOptions): ApiPromise<void> {
    return this.#transport.request(() => ({
      method: 'DELETE',
      path: `${BASE}/${segment('subscriptionId', subscriptionId)}`,
      idempotent: false,
      options,
    }));
  }

  /**
   * Generate a new signing secret. It takes effect at once: new deliveries are
   * signed with it, and your receiver rejects them until it has the new
   * secret. Keep that window short (have the receiver read its secrets from a
   * store you update straight after rotating), keep accepting the old secret
   * too for retries already in flight (pass both to
   * {@link constructWebhookEvent}), and resend anything that failed in the
   * meantime with {@link Webhooks.listDeliveryLogs} (`success: false`) and
   * {@link Webhooks.replayDelivery}.
   */
  rotateSecret(subscriptionId: string, options?: RequestOptions): ApiPromise<WebhookSubscriptionWithSecret> {
    return this.#transport.request(() => ({
      method: 'POST',
      path: `${BASE}/${segment('subscriptionId', subscriptionId)}/rotate-secret`,
      idempotent: false,
      options,
    }));
  }

  /**
   * Queue a real, signed test delivery using the subscription's first event
   * type other than `*` (or `member.updated` for a `*`-only subscription). Its
   * `data` is only `{ test: true, subscriptionId, sentAt }`; detect it with
   * {@link isWebhookTestEvent}.
   */
  test(subscriptionId: string, options?: RequestOptions): ApiPromise<QueuedDelivery> {
    return this.#transport.request(() => ({
      method: 'POST',
      path: `${BASE}/${segment('subscriptionId', subscriptionId)}/test`,
      idempotent: false,
      options,
    }));
  }

  /** List recent delivery attempts across subscriptions. Payloads are PII-masked. */
  listDeliveryLogs(
    params?: ListDeliveryLogsParams,
    options?: RequestOptions,
  ): PagePromise<WebhookDeliveryLog> {
    return this.#transport.list(
      (page) => ({
        method: 'GET',
        path: `${BASE}/delivery-logs`,
        query: {
          page,
          pageSize: params?.pageSize,
          subscriptionId: params?.subscriptionId,
          eventType: params?.eventType,
          success: params?.success,
        },
        idempotent: true,
        options,
      }),
      params?.page,
    );
  }

  /**
   * Re-send a logged delivery to its subscription. The replay keeps the
   * original `eventId`, so receivers that dedupe on it recognise it.
   */
  replayDelivery(logId: string, options?: RequestOptions): ApiPromise<QueuedDelivery> {
    return this.#transport.request(() => ({
      method: 'POST',
      path: `${BASE}/delivery-logs/${segment('logId', logId)}/replay`,
      idempotent: false,
      options,
    }));
  }
}
