// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WebhookVerificationError,
  constructWebhookEvent,
  generateWebhookTestHeaders,
  isWebhookTestEvent,
  verifyWebhookSignature,
} from '../src/index.js';

const SECRET = 'whsec_test_secret';
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const TIMESTAMP = new Date(NOW).toISOString();

const envelope = {
  specversion: '1.0',
  id: 'evt_1',
  type: 'cards.stow.points.changed',
  time: TIMESTAMP,
  event: 'points.changed',
  eventId: 'evt_1',
  occurredAt: TIMESTAMP,
  tenantId: 'merchant_1',
  sourceService: 'merchant-service',
  data: { memberId: 'm1', memberCode: '7K2P9QX4M8', field: 'points', previous: 50, current: 60, delta: 10 },
};
// Signed byte for byte, including the server's key order and spacing.
const BODY = JSON.stringify(envelope);

/** The signer exactly as the notification service implements it. */
function serverSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function serverHeaders(body = BODY, secret = SECRET, timestamp = TIMESTAMP): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': 'stow-cards-webhook/1.0',
    'x-stow-webhook-event': 'points.changed',
    'x-stow-webhook-timestamp': timestamp,
    'x-stow-webhook-subscription': 'sub_1',
    'x-stow-webhook-signature': serverSignature(secret, timestamp, body),
  };
}

describe('verifyWebhookSignature', () => {
  it('accepts a delivery signed by the server algorithm', () => {
    expect(() => {
      verifyWebhookSignature({ payload: BODY, headers: serverHeaders(), secret: SECRET, now: NOW });
    }).not.toThrow();
  });

  it('accepts raw bytes, a Headers object and mixed-case header names', () => {
    const headers = new Headers(serverHeaders());
    expect(() => {
      verifyWebhookSignature({ payload: Buffer.from(BODY), headers, secret: SECRET, now: NOW });
    }).not.toThrow();

    const mixed = Object.fromEntries(
      Object.entries(serverHeaders()).map(([key, value]) => [
        key.replace(/(^|-)\w/g, (s) => s.toUpperCase()),
        value,
      ]),
    );
    expect(() => {
      verifyWebhookSignature({ payload: BODY, headers: mixed, secret: SECRET, now: NOW });
    }).not.toThrow();
  });

  it('accepts array-valued headers as Node delivers duplicates', () => {
    const headers = {
      ...serverHeaders(),
      'x-stow-webhook-signature': [serverSignature(SECRET, TIMESTAMP, BODY)],
    };
    expect(() => {
      verifyWebhookSignature({ payload: BODY, headers, secret: SECRET, now: NOW });
    }).not.toThrow();
  });

  it('verifies non-ASCII bodies over their UTF-8 bytes', () => {
    const body = JSON.stringify({
      ...envelope,
      data: { changeMessage: 'Free coffee redeemed 🎉, teşekkürler' },
    });
    expect(() => {
      verifyWebhookSignature({
        payload: Buffer.from(body),
        headers: serverHeaders(body),
        secret: SECRET,
        now: NOW,
      });
    }).not.toThrow();
  });

  it('accepts any of several secrets during rotation', () => {
    expect(() => {
      verifyWebhookSignature({
        payload: BODY,
        headers: serverHeaders(),
        secret: ['whsec_new', SECRET],
        now: NOW,
      });
    }).not.toThrow();
  });

  it.each([
    ['a tampered body', { payload: BODY.replace('60', '600') }, /does not match/],
    ['a different secret', { secret: 'whsec_other' }, /does not match/],
    ['a stale timestamp', { now: NOW + 5 * 60 * 1000 + 1 }, /tolerance/],
    ['a future timestamp', { now: NOW - 5 * 60 * 1000 - 1 }, /tolerance/],
  ])('rejects %s', (_label, override, message) => {
    expect(() => {
      verifyWebhookSignature({
        payload: BODY,
        headers: serverHeaders(),
        secret: SECRET,
        now: NOW,
        ...override,
      });
    }).toThrow(message);
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN])(
    'refuses a toleranceMs of %s, which would disable replay protection',
    (toleranceMs) => {
      expect(() => {
        verifyWebhookSignature({
          payload: BODY,
          headers: serverHeaders(),
          secret: SECRET,
          now: NOW,
          toleranceMs,
        });
      }).toThrow(TypeError);
    },
  );

  it('refuses a non-finite now', () => {
    expect(() => {
      verifyWebhookSignature({ payload: BODY, headers: serverHeaders(), secret: SECRET, now: Number.NaN });
    }).toThrow(TypeError);
  });

  it('honours a custom tolerance', () => {
    expect(() => {
      verifyWebhookSignature({
        payload: BODY,
        headers: serverHeaders(),
        secret: SECRET,
        now: NOW + 9_000,
        toleranceMs: 10_000,
      });
    }).not.toThrow();
    expect(() => {
      verifyWebhookSignature({
        payload: BODY,
        headers: serverHeaders(),
        secret: SECRET,
        now: NOW,
        toleranceMs: -1,
      });
    }).toThrow(TypeError);
  });

  it.each([
    ['timestamp', 'x-stow-webhook-timestamp', undefined, /Missing x-stow-webhook-timestamp/],
    ['signature', 'x-stow-webhook-signature', undefined, /Missing x-stow-webhook-signature/],
    ['malformed signature', 'x-stow-webhook-signature', 'sha1=abc', /Malformed signature/],
    ['malformed timestamp', 'x-stow-webhook-timestamp', 'yesterday', /Malformed timestamp/],
  ])('rejects a missing or bad %s', (_label, header, value, message) => {
    const headers: Record<string, string | undefined> = { ...serverHeaders(), [header]: value };
    const error = (() => {
      try {
        verifyWebhookSignature({ payload: BODY, headers, secret: SECRET, now: NOW });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect((error as Error).message).toMatch(message);
  });

  it('refuses a parsed object and an empty secret with a clear TypeError', () => {
    expect(() => {
      verifyWebhookSignature({
        payload: envelope as never,
        headers: serverHeaders(),
        secret: SECRET,
        now: NOW,
      });
    }).toThrow(/raw request body/);
    expect(() => {
      verifyWebhookSignature({ payload: BODY, headers: serverHeaders(), secret: '', now: NOW });
    }).toThrow(TypeError);
    expect(() => {
      verifyWebhookSignature({ payload: BODY, headers: serverHeaders(), secret: [], now: NOW });
    }).toThrow(TypeError);
  });
});

describe('constructWebhookEvent', () => {
  it('returns a typed event that narrows on its name', () => {
    const event = constructWebhookEvent({
      payload: BODY,
      headers: serverHeaders(),
      secret: SECRET,
      now: NOW,
    });
    expect(event.eventId).toBe('evt_1');
    if (isWebhookTestEvent(event) || event.event !== 'points.changed')
      throw new Error('expected points.changed');
    expect(event.data.current).toBe(60);
  });

  it('rejects a signed body that is not an event envelope', () => {
    const notJson = 'not json';
    expect(() =>
      constructWebhookEvent({ payload: notJson, headers: serverHeaders(notJson), secret: SECRET, now: NOW }),
    ).toThrow(/not valid JSON/);
    const notEnvelope = '{"hello":"world"}';
    expect(() =>
      constructWebhookEvent({
        payload: notEnvelope,
        headers: serverHeaders(notEnvelope),
        secret: SECRET,
        now: NOW,
      }),
    ).toThrow(/not a Stow Cards event envelope/);
  });

  it('rejects a signed envelope without data', () => {
    const noData = JSON.stringify({ event: 'points.changed', eventId: 'evt_1' });
    expect(() =>
      constructWebhookEvent({ payload: noData, headers: serverHeaders(noData), secret: SECRET, now: NOW }),
    ).toThrow(/not a Stow Cards event envelope/);
  });

  it('tells a test delivery apart from a real event', () => {
    const testBody = JSON.stringify({
      ...envelope,
      data: { test: true, subscriptionId: 'sub_1', sentAt: TIMESTAMP },
    });
    const testEvent = constructWebhookEvent({
      payload: testBody,
      headers: serverHeaders(testBody),
      secret: SECRET,
      now: NOW,
    });
    const realEvent = constructWebhookEvent({
      payload: BODY,
      headers: serverHeaders(),
      secret: SECRET,
      now: NOW,
    });

    expect(isWebhookTestEvent(testEvent)).toBe(true);
    expect(isWebhookTestEvent(realEvent)).toBe(false);
    if (!isWebhookTestEvent(realEvent) && realEvent.event === 'points.changed') {
      expect(realEvent.data.current).toBe(60);
    }
  });

  it('does not parse a delivery that fails verification', () => {
    expect(() =>
      constructWebhookEvent({ payload: BODY, headers: serverHeaders(), secret: 'wrong', now: NOW }),
    ).toThrow(WebhookVerificationError);
  });
});

describe('generateWebhookTestHeaders', () => {
  it('produces headers that match the server signer and verify', () => {
    const headers = generateWebhookTestHeaders({
      payload: BODY,
      secret: SECRET,
      timestamp: new Date(NOW),
      event: 'points.changed',
    });
    expect(headers).toEqual({
      'content-type': 'application/json',
      'x-stow-webhook-event': 'points.changed',
      'x-stow-webhook-timestamp': TIMESTAMP,
      'x-stow-webhook-signature': serverSignature(SECRET, TIMESTAMP, BODY),
    });
    expect(constructWebhookEvent({ payload: BODY, headers, secret: SECRET, now: NOW }).event).toBe(
      'points.changed',
    );
  });

  it('defaults the timestamp to now and the event to member.created', () => {
    const headers = generateWebhookTestHeaders({ payload: BODY, secret: SECRET });
    expect(headers['x-stow-webhook-event']).toBe('member.created');
    expect(() => {
      verifyWebhookSignature({ payload: BODY, headers, secret: SECRET });
    }).not.toThrow();
  });
});
