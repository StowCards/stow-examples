// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

// At the till: scan a pass, then add a stamp or redeem the reward.
//
//   export STOW_API_KEY=stow_...
//   node examples/till-scan.mjs "MEMBER-7K2P9QX4M8" [order-id]
//
// The member and the order id together make the idempotency keys, so any order id
// works, and the same order id at another till or for another customer is a
// separate gesture.
import { createHash } from 'node:crypto';
import { ConflictError, StowClient, parseMemberBarcode } from '@stowcards/sdk';

const [scanned, orderId = String(Date.now())] = process.argv.slice(2);
if (!scanned) {
  console.error('Usage: node examples/till-scan.mjs <scanned barcode text> [order-id]');
  process.exit(2);
}

const stow = new StowClient();

// Teach the parser your programs' barcode templates (optional but most precise).
const programs = await stow.programs.list();
const templates = programs.map((program) => program.barcode?.valueTemplate);

const code = parseMemberBarcode(scanned, { templates });
const member = code ? await stow.members.findByCode(code) : null;
if (!member) {
  console.log('No member for this pass.');
  process.exit(1);
}
console.log(`Member ${member.memberCode}: ${member.firstName} ${member.lastName}`);

// The API keeps an Idempotency-Key for your whole merchant for 24 hours and
// replays its stored answer, whichever member or endpoint it arrives with. So
// each key covers the member and the complete order id (hashed: an order id may
// hold characters a key cannot, 8 to 128 of [A-Za-z0-9_-]), with one name per action.
const gesture = createHash('sha256').update(`${member.id}\n${orderId}`).digest('base64url');

try {
  // A double tap on the same order cannot add two stamps.
  const result = await stow.members.adjustPoints(
    member.id,
    { delta: 1 },
    { idempotencyKey: `till-stamp-${gesture}` },
  );
  console.log(`Balance ${result.previous} -> ${result.current}`);
} catch (error) {
  // A full card's refusal is not stored against the key, so running this order
  // again after its reward was redeemed would add a stamp. A real till records
  // which action each order took and repeats only that one.
  if (error instanceof ConflictError && error.code === 'STAMP_CARD_FULL') {
    const redeemed = await stow.members.redeemReward(
      member.id,
      { changeMessage: 'Enjoy your free coffee!' },
      { idempotencyKey: `till-redeem-${gesture}` },
    );
    console.log(`Reward redeemed; balance now ${redeemed.current}`);
  } else {
    throw error;
  }
}
