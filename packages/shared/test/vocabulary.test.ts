import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isVocabularySegment, pathWords, vocabulary } from '../src/index.js';

/** tools/vocabulary/names.txt: common first and last names from many countries (CC0). */
const NAMES = readFileSync(new URL('../../../tools/vocabulary/names.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'));

describe('pathWords', () => {
  it.each([
    ['payment-methods', ['payment', 'methods']],
    ['line_items', ['line', 'items']],
    ['bulkUpdate', ['bulk', 'update']],
    ['getHTTPStatus', ['get', 'http', 'status']],
    ['Anna.Kowalska', ['anna', 'kowalska']],
    ['o%27brien', ['o', 'brien']],
    ['oauth2', ['oauth2']],
    ['---', []],
  ])('%s', (seg, words) => {
    expect(pathWords(seg)).toEqual(words);
  });
});

describe('isVocabularySegment', () => {
  it.each([
    'cards',
    'payment-methods',
    'line_items',
    'bulkUpdate',
    'tracking',
    'completions',
    'attachments',
    'People',
    'step-2',
  ])('%s is made of vocabulary words', (seg) => {
    expect(isVocabularySegment(seg)).toBe(true);
  });

  it.each(['ivan-wei', 'olga', 'john-smith', 'blue-running-shoes', 'acme', 'o%27brien', ''])(
    '%s is not',
    (seg) => {
      expect(isVocabularySegment(seg)).toBe(false);
    },
  );

  it('takes extra allowed words (a provider’s)', () => {
    expect(isVocabularySegment('blue-running-shoes', new Set(['blue', 'running', 'shoes']))).toBe(
      true,
    );
    expect(isVocabularySegment('blue-running-shoes', new Set(['blue', 'running']))).toBe(false);
  });
});

describe('vocabulary data', () => {
  it('is compact', () => {
    expect(vocabulary().size).toBeGreaterThan(1000);
    expect([...vocabulary()].join(' ').length).toBeLessThan(40_000);
  });

  it('holds no personal names except the documented ordinary-word collisions', () => {
    // keep in sync with docs/privacy.md (residual risk) and tools/vocabulary/report.md
    const collisions = [
      'ai',
      'long',
      'mark',
      'max',
      'min',
      'or',
      'price',
      'run',
      'sim',
      'to',
      'uri',
    ];
    expect(NAMES.length).toBeGreaterThan(3000);
    expect(NAMES.filter((n) => vocabulary().has(n)).sort()).toEqual(collisions);
  });
});
