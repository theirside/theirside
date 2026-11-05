import { VOCABULARY_WORDS } from './vocabulary-words.js';

/**
 * The path-word vocabulary (`vocabulary-words.ts`, mined by tools/vocabulary
 * from the APIs.guru OpenAPI directory): words real APIs use in their paths,
 * minus personal names. In strict path privacy a literal segment is sent
 * as-is only when every word in it is in here (or in the provider's allowed
 * words); see docs/privacy.md.
 */
let words: Set<string> | undefined;
export function vocabulary(): ReadonlySet<string> {
  words ??= new Set(VOCABULARY_WORDS.split(' '));
  return words;
}

function safeDecode(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Words of one path segment, lower-cased: split on anything but letters and
 * digits and at camelCase boundaries (`payment-methods`, `line_items`,
 * `bulkUpdate`, `getHTTPStatus` → get http status). Same split as
 * tools/vocabulary/src/build.mjs.
 */
export function pathWords(segment: string): string[] {
  return safeDecode(segment)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
}

const RE_SHORT_NUMBER = /^\d{1,3}$/;

/**
 * True when every word of the segment is a vocabulary word, one of `extra`
 * (a provider's allowed words, lower-case) or a short number (`step-2`).
 */
export function isVocabularySegment(segment: string, extra?: ReadonlySet<string>): boolean {
  const parts = pathWords(segment);
  if (parts.length === 0) return false;
  const v = vocabulary();
  for (const p of parts) if (!v.has(p) && !extra?.has(p) && !RE_SHORT_NUMBER.test(p)) return false;
  return true;
}
