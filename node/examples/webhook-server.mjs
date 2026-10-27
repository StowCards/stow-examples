// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

// A dependency-free webhook receiver that verifies every delivery.
//
//   export STOW_WEBHOOK_SECRET=...   # from webhooks.create() or rotateSecret()
//   node examples/webhook-server.mjs
//
// Expose it over HTTPS (Stow Cards only delivers to https URLs) and register
// the URL with stow.webhooks.create({ name, url, events }).
import { createServer } from 'node:http';
import { WebhookVerificationError, constructWebhookEvent, isWebhookTestEvent } from '@stowcards/sdk';

const secret = process.env.STOW_WEBHOOK_SECRET;
if (!secret) throw new Error('Set STOW_WEBHOOK_SECRET.');

const seen = new Set(); // Use a durable store in production: deliveries are at-least-once.

// Deliveries are small. Cap what an unauthenticated sender can make us buffer
// before the signature is checked.
const MAX_BODY_BYTES = 1024 * 1024;

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/stow/webhooks') {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  let received = 0;
  let tooLarge = false;
  req.on('data', (chunk) => {
    if (tooLarge) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      // Stop reading once the reply is out.
      res.writeHead(413, { Connection: 'close' }).end(() => req.destroy());
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) return;
    let event;
    try {
      // Verify over the exact bytes received, never a re-serialised object.
      event = constructWebhookEvent({ payload: Buffer.concat(chunks), headers: req.headers, secret });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        res.writeHead(400).end();
        return;
      }
      throw error;
    }

    // Test deliveries (stow.webhooks.test) carry only { test, subscriptionId, sentAt }.
    if (isWebhookTestEvent(event)) {
      console.log(`Test delivery for subscription ${event.data.subscriptionId}`);
      res.writeHead(204).end();
      return;
    }

    if (seen.has(event.eventId)) {
      res.writeHead(204).end();
      return;
    }
    seen.add(event.eventId);

    switch (event.event) {
      case 'member.created':
        console.log(`New member ${event.data.memberCode} (${event.data.email})`);
        break;
      case 'points.changed':
        console.log(`${event.data.memberCode}: ${event.data.previous} -> ${event.data.current}`);
        break;
      case 'reward.redeemed':
        console.log(`${event.data.memberCode} redeemed a reward`);
        break;
      default:
        console.log(`Unhandled event ${event.event}`);
    }
    // Acknowledge quickly; do slow work asynchronously.
    res.writeHead(204).end();
  });
});

server.listen(3000, () => {
  console.log('Listening on http://localhost:3000/stow/webhooks');
});
