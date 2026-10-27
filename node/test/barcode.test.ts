// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { parseMemberBarcode } from '../src/index.js';

const SERIAL = '0b6f7c1e-4d2a-4c8e-9a51-3e7d2f90c4ab';

describe('parseMemberBarcode', () => {
  it.each([
    ['MEMBER-X7K2M9PQ4T', 'X7K2M9PQ4T'],
    ['OFFER-X7K2M9PQ4T', 'X7K2M9PQ4T'],
    ['  X7K2M9PQ4T  ', 'X7K2M9PQ4T'],
    [SERIAL, SERIAL],
    ['https://s.cards/p/X7K2M9PQ4T', 'X7K2M9PQ4T'],
    ['https://s.cards/scan?memberCode=X7K2M9PQ4T&utm=1', 'X7K2M9PQ4T'],
    ['https://s.cards/scan?ID=X7K2M9PQ4T', 'X7K2M9PQ4T'],
    ['https://s.cards/p/X7K2%2DM9', 'X7K2-M9'],
    ['{"memberCode":"X7K2M9PQ4T","points":12}', 'X7K2M9PQ4T'],
    ['{"id":12345}', '12345'],
  ])('reads %j without templates', (raw, expected) => {
    expect(parseMemberBarcode(raw)).toBe(expected);
  });

  it.each([
    ['https://example.com/p/{{memberCode}}', 'https://example.com/p/X7K2M9PQ4T', 'X7K2M9PQ4T'],
    ['LOYAL:{{ memberCode }}:{{points}}', 'LOYAL:X7K2M9PQ4T:120', 'X7K2M9PQ4T'],
    ['{{firstName}}|{{memberId}}', `Ada|${SERIAL}`, SERIAL],
    ['MEMBER-{{memberCode}}', 'MEMBER-X7K2M9PQ4T', 'X7K2M9PQ4T'],
  ])('reverses the template %j', (template, raw, expected) => {
    expect(parseMemberBarcode(raw, { templates: ['{{memberCode}}', template] })).toBe(expected);
  });

  it('does not absorb a hyphenated neighbouring token into the identifier', () => {
    const templates = ['MEMBER-{{memberCode}}-{{firstName}}'];
    expect(parseMemberBarcode('MEMBER-X7K2M9PQ4T-Anne-Marie', { templates })).toBe('X7K2M9PQ4T');
    expect(parseMemberBarcode(`MEMBER-${SERIAL}-Jean-Luc`, { templates })).toBe(SERIAL);
  });

  it('prefers the most specific template', () => {
    const templates = ['C-{{memberCode}}', 'CARD-{{memberCode}}'];
    expect(parseMemberBarcode('CARD-X7K2M9PQ4T', { templates })).toBe('X7K2M9PQ4T');
  });

  it('returns null for a fixed promotional barcode and for empty input', () => {
    expect(
      parseMemberBarcode('SUMMER-SALE', { templates: ['SUMMER-SALE', '', 'MEMBER-{{memberCode}}'] }),
    ).toBeNull();
    expect(parseMemberBarcode('   ')).toBeNull();
    expect(parseMemberBarcode(undefined as never)).toBeNull();
  });

  it('falls back when nothing structured matches', () => {
    expect(parseMemberBarcode('{not json}')).toBe('{not json}');
    expect(parseMemberBarcode('{"other":true}')).toBe('{"other":true}');
    expect(parseMemberBarcode('https://s.cards/')).toBe('https://s.cards/');
    expect(parseMemberBarcode('https://s.cards/p/%E0%A4%A')).toBe('%E0%A4%A');
    expect(parseMemberBarcode('MEMBER-X7', { templates: ['{{points}}', 'NO-TOKENS-{{tier}}'] })).toBe('X7');
  });
});
