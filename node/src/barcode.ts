// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn a scanned pass barcode back into the member identifier that
 * {@link Members.findByCode} looks up.
 *
 * A pass barcode encodes the program's barcode template with the member's
 * values filled in, for example `MEMBER-{{memberCode}}` becomes
 * `MEMBER-7K2P9QX4M8`. The lookup matches only the bare code, so a till must
 * strip the template first.
 */

/** Template tokens that carry the member's unique identifier. */
const ID_TOKENS: ReadonlySet<string> = new Set(['memberCode', 'memberId', 'serialNumber']);
/**
 * A member identifier exactly: a legacy pass serial (a UUID) or a Member ID
 * (10 letters and digits). Bounded, so a neighbouring token that contains a
 * hyphen (`MEMBER-{{memberCode}}-{{firstName}}` with "Anne-Marie") cannot be
 * absorbed into the identifier.
 */
const ID_CAPTURE =
  '([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[A-Za-z0-9]{10})';
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;
/** Upper-case product labels the stock templates prefix the code with (`MEMBER-`, `OFFER-`, …). */
const LABEL_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,15}-(.+)$/;
const URL_SCHEME_PATTERN = /^[a-z][\w+.-]*:\/\//i;
const URL_ID_PARAMS = ['membercode', 'member', 'serialnumber', 'serial', 'memberid', 'code', 'id', 'm'];
const JSON_ID_KEYS = ['memberCode', 'memberId', 'serialNumber', 'serial', 'code', 'id'];

/** Options of {@link parseMemberBarcode}. */
export interface ParseMemberBarcodeOptions {
  /**
   * The `barcode.valueTemplate` of your programs (from
   * {@link Programs.list}); missing entries are ignored. Without them, the
   * stock `LABEL-<code>` shapes, URLs, JSON payloads and bare codes are still
   * recognised.
   */
  templates?: readonly (string | null | undefined)[] | undefined;
}

interface Matcher {
  pattern: RegExp;
  idGroups: number[];
  literals: number;
}

/**
 * Extract the member identifier (the Member ID `memberCode`, or a legacy
 * pass serial) from a scanned barcode or QR payload.
 *
 * @param raw - The decoded barcode text.
 * @returns The identifier to pass to {@link Members.findByCode}. `null` for
 * empty input, or for a payload identical to one of `templates` that has no
 * member token (a fixed promotional barcode). Any other payload yields the
 * parser's best reading, possibly the text itself, in which case
 * {@link Members.findByCode} simply finds no member.
 *
 * @example
 * ```ts
 * parseMemberBarcode('MEMBER-7K2P9QX4M8'); // '7K2P9QX4M8'
 * parseMemberBarcode('https://example.com/p/7K2P9QX4M8', {
 *   templates: ['https://example.com/p/{{memberCode}}'],
 * }); // '7K2P9QX4M8'
 * ```
 */
export function parseMemberBarcode(raw: string, options?: ParseMemberBarcodeOptions): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return null;
  const templates = options?.templates ?? [];

  // A tokenless ("fixed") template is identical on every pass and carries no member.
  for (const template of templates) {
    const trimmed = (template ?? '').trim();
    if (trimmed !== '' && !hasToken(trimmed) && trimmed === value) return null;
  }

  const fromTemplate = matchTemplates(value, templates);
  if (fromTemplate !== null) return fromTemplate;

  if (URL_SCHEME_PATTERN.test(value)) {
    const fromUrl = matchUrl(value);
    if (fromUrl !== null) return fromUrl;
  }

  const fromJson = matchJson(value);
  if (fromJson !== null) return fromJson;

  // A bare memberCode has no hyphen and a bare UUID is lower case, so neither is touched here.
  const labelled = LABEL_PREFIX_PATTERN.exec(value);
  if (labelled?.[1] !== undefined) return labelled[1].trim();

  return value;
}

function hasToken(template: string): boolean {
  TOKEN_PATTERN.lastIndex = 0;
  const found = TOKEN_PATTERN.test(template);
  TOKEN_PATTERN.lastIndex = 0;
  return found;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a template into an anchored matcher; null when it cannot identify a member. */
function compileTemplate(template: string | null | undefined): Matcher | null {
  const trimmed = (template ?? '').trim();
  if (trimmed === '') return null;
  let source = '^';
  let last = 0;
  let group = 0;
  let literals = 0;
  const idGroups: number[] = [];
  for (const match of trimmed.matchAll(TOKEN_PATTERN)) {
    const literal = trimmed.slice(last, match.index);
    literals += literal.length;
    source += escapeRegExp(literal);
    group += 1;
    if (ID_TOKENS.has(match[1] ?? '')) {
      idGroups.push(group);
      source += ID_CAPTURE;
    } else {
      source += '(.*?)';
    }
    last = match.index + match[0].length;
  }
  const tail = trimmed.slice(last);
  literals += tail.length;
  source += `${escapeRegExp(tail)}$`;
  // No id token, or a bare token with nothing to anchor on: the fallbacks handle those.
  if (idGroups.length === 0 || literals === 0) return null;
  return { pattern: new RegExp(source), idGroups, literals };
}

function matchTemplates(value: string, templates: readonly (string | null | undefined)[]): string | null {
  const matchers = templates
    .map(compileTemplate)
    .filter((matcher): matcher is Matcher => matcher !== null)
    .sort((a, b) => b.literals - a.literals);
  for (const { pattern, idGroups } of matchers) {
    const match = pattern.exec(value);
    if (!match) continue;
    for (const group of idGroups) {
      const id = (match[group] ?? '').trim();
      if (id !== '') return id;
    }
  }
  return null;
}

function matchUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  for (const name of URL_ID_PARAMS) {
    for (const [key, param] of url.searchParams) {
      if (key.toLowerCase() === name && param.trim() !== '') return param.trim();
    }
  }
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (last === undefined) return null;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Keep the raw segment.
  }
  return decoded.trim() || null;
}

function matchJson(value: string): string | null {
  if (!(value.startsWith('{') && value.endsWith('}'))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of JSON_ID_KEYS) {
    const id = record[key];
    if (typeof id === 'string' && id.trim() !== '') return id.trim();
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  }
  return null;
}
