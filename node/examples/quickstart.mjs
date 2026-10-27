// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

// The whole loyalty loop: find a program, enrol a member, award points and
// read the member back.
//
//   export STOW_API_KEY=stow_...
//   node examples/quickstart.mjs
import { StowApiError, StowClient } from '@stowcards/sdk';

const stow = new StowClient({ appInfo: { name: 'stow-quickstart', version: '1.0.0' } });

try {
  const programs = await stow.programs.list();
  const program = programs.find((candidate) => candidate.status === 'active');
  if (!program) throw new Error('Publish a program in the Stow Cards console first.');

  const member = await stow.members.enroll({
    programId: program._id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    initialPoints: 50,
  });
  console.log(member.deduped ? 'Already enrolled:' : 'Enrolled:', member.memberCode);
  console.log('Add to Apple Wallet:', member.apple?.passUrl);
  console.log('Save to Google Wallet:', member.google?.saveUrl);

  // One idempotency key per gesture: retrying this exact call can never award twice.
  const { current } = await stow.members.adjustPoints(
    member.id,
    { delta: 10, changeMessage: 'Thanks for visiting!' },
    { idempotencyKey: `quickstart-${member.id}-visit-1` },
  );
  console.log('New balance:', current);

  const detail = await stow.members.get(member.id);
  console.log('Wallet devices:', detail.deviceCount, 'Apple pass mode:', detail.apple?.mode);
} catch (error) {
  if (error instanceof StowApiError) {
    console.error(`${error.code}: ${error.message} (request ${error.requestId})`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
