// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

// At the till: scan a pass, then add a stamp or redeem the reward.
//
//   export STOW_API_KEY=stow_...
//   node examples/till-scan.mjs "MEMBER-7K2P9QX4M8" [order-id]
//
// The order id becomes part of the idempotency key (`till-order-<id>`), so any id
// works: characters a key cannot hold are replaced with `-`.
import { ConflictError, StowClient, parseMemberBarcode } from '@stowcards/sdk';

const [scanned, orderId = String(Date.now())] = process.argv.slice(2);
if (!scanned) {
  console.error('Usage: node examples/till-scan.mjs <scanned barcode text> [order-id]');
  process.exit(2);
}

// Keys are 8 to 128 characters of [A-Za-z0-9_-]; the prefix keeps a short id long enough.
const gestureKey = `till-order-${orderId.replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 120);

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

try {
  // The order id makes the gesture idempotent: a double tap cannot add two stamps.
  const result = await stow.members.adjustPoints(member.id, { delta: 1 }, { idempotencyKey: gestureKey });
  console.log(`Balance ${result.previous} -> ${result.current}`);
} catch (error) {
  if (error instanceof ConflictError && error.code === 'STAMP_CARD_FULL') {
    const redeemed = await stow.members.redeemReward(
      member.id,
      { changeMessage: 'Enjoy your free coffee!' },
      { idempotencyKey: `${gestureKey}-redeem` },
    );
    console.log(`Reward redeemed; balance now ${redeemed.current}`);
  } else {
    throw error;
  }
}
