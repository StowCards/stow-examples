// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

// The whole loyalty loop: find a program, enrol a member, award points and
// read the member back.
//
//   export STOW_API_KEY=stow_...
//   node examples/quickstart.mjs
//
// Exits with 2 for a configuration error and 1 for an API or connection error.
import { randomUUID } from 'node:crypto';
import { StowApiError, StowClient, StowError } from '@stowcards/sdk';

let stow;
try {
  stow = new StowClient({ appInfo: { name: 'stow-quickstart', version: '1.0.0' } });
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(2);
}

try {
  // The first active program with a points balance (points, tiered or gift
  // card), else the first active stamp card, which moves one stamp at a time.
  // Other pass types (coupons, memberships, tickets...) have no balance.
  const active = (await stow.programs.list()).filter((candidate) => candidate.status === 'active');
  const program =
    active.find((candidate) => ['points', 'tiered', 'giftCard'].includes(candidate.programType)) ??
    active.find((candidate) => candidate.programType === 'stamps');
  if (!program) {
    console.error(
      'Error: No active points, tiered, gift card or stamp card program. Publish one in the Stow Cards console first.',
    );
    process.exit(1);
  }
  const stamps = program.programType === 'stamps';

  // A fresh email per run, so a second run enrols a new member instead of
  // getting the first one back. A stamp card starts empty: 50 would fill it.
  const member = await stow.members.enroll({
    programId: program._id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `dev+${String(Date.now())}@example.com`,
    ...(stamps ? {} : { initialPoints: 50 }),
  });
  console.log(member.deduped ? 'Already enrolled:' : 'Enrolled:', member.memberCode);
  console.log('Add to Apple Wallet:', member.apple?.passUrl);
  console.log('Save to Google Wallet:', member.google?.saveUrl);

  // One idempotency key per gesture: keep it if you retry this gesture
  // yourself, so the change can never apply twice. A new gesture needs a new key.
  const { current } = await stow.members.adjustPoints(
    member.id,
    { delta: stamps ? 1 : 10, changeMessage: 'Thanks for visiting!' },
    { idempotencyKey: randomUUID() },
  );
  console.log('New balance:', current);

  const detail = await stow.members.get(member.id);
  console.log('Wallet devices:', detail.deviceCount, 'Apple pass mode:', detail.apple?.mode);
} catch (error) {
  if (error instanceof StowApiError) {
    console.error(`Error: ${error.code}: ${error.message} (request ${error.requestId})`);
    process.exitCode = 1;
  } else if (error instanceof StowError) {
    // No HTTP answer: StowConnectionError or StowTimeoutError.
    console.error(`Error: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
