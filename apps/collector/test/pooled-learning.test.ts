import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLearnedCache, learnedPositions } from '../src/modules/discovery/pooled-learning.js';
import { FakeClock } from '../src/util/clock.js';
import {
  TEST_API_KEY,
  batch,
  event,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

// 17 vocabulary words: one past the per-position limit of 16
const WORDS = [
  'accounts',
  'payments',
  'cards',
  'customers',
  'invoices',
  'orders',
  'refunds',
  'charges',
  'transfers',
  'balances',
  'disputes',
  'payouts',
  'products',
  'prices',
  'coupons',
  'taxes',
  'files',
];

describe('learnedPositions', () => {
  const t = (endpoint: string, host = 'api.acme.test') => ({ provider: 'Acme', host, endpoint });

  it('a position with more than 16 distinct words is an ID position', () => {
    expect(learnedPositions(WORDS.map((w) => t(`/v1/${w}`)))).toEqual([
      { provider: 'Acme', hosts: ['api.acme.test'], parent: '/v1', position: 1 },
    ]);
    expect(learnedPositions(WORDS.slice(0, 16).map((w) => t(`/v1/${w}`)))).toEqual([]);
  });

  it('counts under the templated parent; 17 versions at one position are not 17 words', () => {
    const rows = WORDS.flatMap((w, i) => [
      t(`/v1/customers/:id/${w}`, i % 2 ? 'api.acme.test' : 'files.acme.test'),
      t(`/v${i + 1}/x`),
      t(`/_ah/api/svc/v1/m`),
    ]);
    expect(learnedPositions(rows)).toEqual([
      {
        provider: 'Acme',
        hosts: expect.arrayContaining(['api.acme.test', 'files.acme.test']),
        parent: '/v1/customers/:id',
        position: 3,
      },
    ]);
  });
});

describe('pooled learning through the remote config', () => {
  let t: TestApp;
  const START = Date.UTC(2026, 10, 7, 9, 0);
  beforeAll(async () => {
    t = await startTestApp({ clock: new FakeClock(START) });
    clearLearnedCache();
    // three processes of card-fn, each seeing 6 words: 17 together, under 16 each
    for (let p = 0; p < 3; p++) {
      const events = WORDS.slice(p * 6, p * 6 + 6).map((w) =>
        event({ ts: START, provider: 'Acme', host: 'api.acme.test', endpoint: `/v1/${w}` }),
      );
      const res = await t.app.inject(
        ingestRequest(
          batch(events, { service: 'card-fn', instance: { id: `p${p}`, startedAt: START } }),
        ),
      );
      expect(res.statusCode).toBe(202);
    }
    // another service with a few of the same words
    const other = WORDS.slice(0, 5).map((w) =>
      event({ ts: START, provider: 'Acme', host: 'api.acme.test', endpoint: `/v1/${w}` }),
    );
    expect(
      (await t.app.inject(ingestRequest(batch(other, { service: 'ledger' })))).statusCode,
    ).toBe(202);
  });
  afterAll(async () => t.close());

  const config = async (query: string) =>
    (
      await t.app.inject({
        method: 'GET',
        url: `/v1/sdk-config${query}`,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
      })
    ).json();

  it('serves the positions the service learned together, to that service only', async () => {
    expect((await config('?service=card-fn&environment=production')).learned).toEqual([
      { provider: 'Acme', hosts: ['api.acme.test'], parent: '/v1', position: 1 },
    ]);
    expect((await config('?service=ledger&environment=production')).learned).toBeUndefined();
    expect((await config('?service=card-fn&environment=staging')).learned).toBeUndefined();
    // older SDKs don't ask: nothing changes for them
    expect((await config('')).learned).toBeUndefined();
  });

  it('stores each template once, however many batches carry it', async () => {
    const rows = await t.db.storage.config.listServiceTemplates(
      { orgId: t.orgId, projectId: t.projectId },
      'card-fn',
      'production',
      new Date(START - 60_000),
    );
    expect(rows).toHaveLength(17);
  });
});
