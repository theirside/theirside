import { describe, expect, it } from 'vitest';
import {
  nextAliases,
  planEndpointMerges,
  refines,
  type EndpointKey,
} from '../src/modules/discovery/endpoint-merge.js';

const ALLOWED = new Set(['orderendpoint', 'ordercore']);
const post = (...endpoints: string[]): EndpointKey[] =>
  endpoints.map((endpoint) => ({ method: 'POST', endpoint }));
const merges = (keys: EndpointKey[], allowed: ReadonlySet<string> = ALLOWED) =>
  planEndpointMerges(keys, allowed).merges.map((m) => [m.endpoint, m.to, m.reason]);

describe('planEndpointMerges', () => {
  it('collapses repeated slashes', () => {
    expect(merges(post('/_ah/api//orderendpoint/v1/getOrderHistory'))).toEqual([
      [
        '/_ah/api//orderendpoint/v1/getOrderHistory',
        '/_ah/api/orderendpoint/v1/getOrderHistory',
        'slashes',
      ],
    ]);
  });

  // [case, templates, expected merges [from, to]]
  const cases: [string, string[], [string, string][]][] = [
    [
      'services that learned the provider name or the framework words differently',
      [
        '/_ah/api/orderendpoint/v1/getOrderHistory',
        '/:id/api/orderendpoint/v1/getOrderHistory',
        '/_ah/api/:id/v1/getOrderHistory',
        '/:id/api/:id/v1/getOrderHistory',
      ],
      [
        ['/:id/api/orderendpoint/v1/getOrderHistory', '/_ah/api/orderendpoint/v1/getOrderHistory'],
        ['/_ah/api/:id/v1/getOrderHistory', '/_ah/api/orderendpoint/v1/getOrderHistory'],
        ['/:id/api/:id/v1/getOrderHistory', '/_ah/api/orderendpoint/v1/getOrderHistory'],
      ],
    ],
    [
      'a vocabulary word is not enough: /users/:id is not /users/me',
      ['/users/me', '/users/:id'],
      [],
    ],
    [
      'an :id that stands for several methods stays (vocabulary words, too)',
      [
        '/_ah/api/orderendpoint/v1/getOrderHistory',
        '/_ah/api/orderendpoint/v1/getBalance',
        '/_ah/api/orderendpoint/v1/:id',
      ],
      [],
    ],
    [
      'two equally specific targets: ambiguous, nothing merges',
      [
        '/_ah/api/:id/v1/getOrderHistory',
        '/_ah/api/orderendpoint/v1/getOrderHistory',
        '/_ah/api/ordercore/v1/getOrderHistory',
      ],
      [],
    ],
    [
      'a word the provider does not allow never replaces an :id',
      ['/rpc/:id/v1/getOrderHistory', '/rpc/otherendpoint/v1/getOrderHistory'],
      [],
    ],
    [
      'only an :id may become a word: other differences block the merge',
      ['/_ah/api/orderendpoint/v1/getOrderHistory', '/:id/api/orderendpoint/v2/getOrderHistory'],
      [],
    ],
    [
      'Cloud Endpoints words only in the Cloud Endpoints shape',
      ['/_ah/api/orderendpoint/list', '/:id/api/orderendpoint/list'],
      [],
    ],
    ['route parameters are not :id', ['/cards/:cardId/history', '/cards/orderendpoint/history'], []],
  ];
  it.each(cases)('%s', (_name, templates, expected) => {
    expect(merges(post(...templates)).map(([f, t]) => [f, t])).toEqual(expected);
  });

  it('keeps methods apart', () => {
    expect(
      merges([
        { method: 'GET', endpoint: '/_ah/api/:id/v1/getOrderHistory' },
        { method: 'POST', endpoint: '/_ah/api/orderendpoint/v1/getOrderHistory' },
      ]),
    ).toEqual([]);
  });

  it('uses the allowed words it is given (dashboard + catalog)', () => {
    const keys = post('/_ah/api/:id/v1/getOrderHistory', '/_ah/api/orderendpoint/v1/getOrderHistory');
    expect(merges(keys, new Set())).toEqual([]);
    expect(merges(keys)).toHaveLength(1);
  });

  it('routes: the literal targets only (no doubled-slash variants since 0.3.0)', () => {
    const plan = planEndpointMerges(
      post(
        '/_ah/api/orderendpoint/v1/getOrderHistory',
        '/:id/api/orderendpoint/v1/getOrderHistory',
        // SDK 0.1.0, strict, base URL ending in "/": the empty segment arrived as :id
        '/:id/api/:id/:id/v1/getOrderHistory',
      ),
      ALLOWED,
    );
    expect(plan.routes).toEqual(['/_ah/api/orderendpoint/v1/getOrderHistory']);
    // the 0.1.0 row itself is not merged: which :id was the slash can't be told
    expect(plan.merges.map((m) => m.endpoint)).toEqual(['/:id/api/orderendpoint/v1/getOrderHistory']);
  });

  it('never pushes a target with :id as a route (it would swallow sibling words)', () => {
    const plan = planEndpointMerges(
      post('/cards/:id/orderendpoint', '/:id/:id/orderendpoint'),
      new Set(['cards']),
    );
    expect(plan.merges.map((m) => m.to)).toEqual(['/cards/:id/orderendpoint']);
    expect(plan.routes).toEqual([]);
  });

  it('is idempotent: after the merge, nothing is left to do', () => {
    const before = post(
      '/_ah/api//orderendpoint/v1/getOrderHistory',
      '/_ah/api/orderendpoint/v1/getOrderHistory',
      '/:id/api/orderendpoint/v1/getOrderHistory',
    );
    const plan = planEndpointMerges(before, ALLOWED);
    const after = post(
      ...new Set(
        before.map((k) => plan.merges.find((m) => m.endpoint === k.endpoint)?.to ?? k.endpoint),
      ),
    );
    expect(planEndpointMerges(after, ALLOWED).merges).toEqual([]);
  });
});

describe('allowed words: the whole segment counts (camelCase RPC methods)', () => {
  it('merges an :id into a camelCase method named in the allowed words', () => {
    const allowed = new Set([
      'orderendpoint',
      'getlatestordsumstatus',
      'accountsendpoint',
      'getacctlogintoken',
    ]);
    expect(
      merges(
        post(
          '/_ah/api/orderendpoint/v1/getLatestOrdSumStatus',
          '/_ah/api/orderendpoint/v1/:id',
          '/accountsendpoint/v1/getAcctLoginToken',
          '/:id/v1/getAcctLoginToken',
        ),
        allowed,
      ).map(([f, t]) => [f, t]),
    ).toEqual([
      ['/_ah/api/orderendpoint/v1/:id', '/_ah/api/orderendpoint/v1/getLatestOrdSumStatus'],
      ['/:id/v1/getAcctLoginToken', '/accountsendpoint/v1/getAcctLoginToken'],
    ]);
  });

  it('_ah as an allowed word, outside the Cloud Endpoints shape', () => {
    expect(merges(post('/:id/users/list', '/_ah/users/list'), new Set(['ah']))).toHaveLength(1);
    expect(merges(post('/:id/users/list', '/_ah/users/list'), new Set())).toEqual([]);
  });
});

describe('refines', () => {
  it('needs at least one gained word', () => {
    expect(refines(['a', ':id'], ['a', ':id'], ALLOWED)).toBe(false);
    expect(refines(['a', ':id'], ['a', 'orderendpoint'], ALLOWED)).toBe(true);
  });
});

describe('nextAliases', () => {
  it('points old templates at the final one, flattening chains', () => {
    const a = nextAliases({ 'POST /:id/api/:id/v1/x': '/_ah/api/:id/v1/x' }, [
      {
        method: 'POST',
        endpoint: '/_ah/api/:id/v1/x',
        to: '/_ah/api/orderendpoint/v1/x',
        reason: 'specific',
      },
      { method: 'POST', endpoint: '/a//b', to: '/a/b', reason: 'slashes' },
    ]);
    expect(a).toEqual({
      'POST /:id/api/:id/v1/x': '/_ah/api/orderendpoint/v1/x',
      'POST /_ah/api/:id/v1/x': '/_ah/api/orderendpoint/v1/x',
    });
  });
});
