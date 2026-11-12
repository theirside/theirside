import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_WORD,
  EndpointTemplater,
  RouteLearner,
  isVocabularySegment,
  normalizePathWord,
  pathWords,
  vocabulary,
} from '../src/index.js';

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

describe('allowed path words (camelCase RPC methods, `_ah`)', () => {
  // what the dashboard stores for what people typed
  const ALLOWED = new Set(
    ['orderendpoint', 'accountsendpoint', 'getLatestOrdSumStatus', 'getAcctLoginToken', '_ah'].map(
      normalizePathWord,
    ),
  );

  it.each([
    ['getLatestOrdSumStatus', 'getlatestordsumstatus'],
    ['getAcctLoginToken', 'getacctlogintoken'],
    ['_ah', 'ah'],
    ['order_sum-status.v2', 'ordersumstatusv2'],
    ['  Sneakers ', 'sneakers'],
    ['caf%C3%A9', 'café'],
  ])('normalizePathWord(%j) = %j', (input, out) => {
    expect(normalizePathWord(input)).toBe(out);
  });

  it('a word is letters and digits once normalized', () => {
    expect(ALLOWED_WORD.test(normalizePathWord('_ah'))).toBe(true);
    expect(ALLOWED_WORD.test(normalizePathWord('two words'))).toBe(false);
    expect(ALLOWED_WORD.test(normalizePathWord('café'))).toBe(false);
  });

  it.each([
    ['getLatestOrdSumStatus', true],
    ['getAcctLoginToken', true],
    ['_ah', true],
    ['orderendpoint', true],
    // all parts are vocabulary words: worked before too
    ['getOrderHistory', true],
    // allowed as a whole, not as a part of something else
    ['getLatestOrdSumStatusV2', false],
  ])('%s passes with the allowed words: %s', (segment, ok) => {
    expect(isVocabularySegment(segment, ALLOWED)).toBe(ok);
  });

  it('without the allowed words the RPC methods are :id material', () => {
    expect(isVocabularySegment('getLatestOrdSumStatus')).toBe(false);
    expect(isVocabularySegment('_ah')).toBe(false);
  });

  it('the learner sends them as-is in strict mode', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner() });
    const policy = { privacy: 'strict' as const, allowedWords: ALLOWED };
    expect(t.template('h', '/_ah/api/orderendpoint/v1/getLatestOrdSumStatus', [], policy)).toBe(
      '/_ah/api/orderendpoint/v1/getLatestOrdSumStatus',
    );
    expect(t.template('h', '/accountsendpoint/v1/getAcctLoginToken', [], policy)).toBe(
      '/accountsendpoint/v1/getAcctLoginToken',
    );
    // `_ah` outside the Cloud Endpoints shape: the allowed word
    expect(t.template('h', '/_ah/users/list', [], policy)).toBe('/_ah/users/list');
    // without the word (a fresh templater: lookups are cached per host and path)
    expect(
      new EndpointTemplater({ learner: new RouteLearner() }).template('h', '/_ah/users/list'),
    ).toBe('/:id/users/list');
  });
});
