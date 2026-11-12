import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyHistogram, type CallEvent } from '@theirside/shared';
import { endpointMergeJob } from '../src/modules/discovery/jobs.js';
import { mergeEndpoints } from '../src/modules/discovery/endpoint-merge.js';
import { refreshBaselines } from '../src/modules/scoring/baseline.js';
import { resolveThresholds } from '../src/modules/scoring/thresholds.js';
import type { Incident } from '../src/storage/types.js';
import { FakeClock } from '../src/util/clock.js';
import {
  THEIRSIDE_ADMIN_TOKEN,
  TEST_API_KEY,
  batch,
  event,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

/**
 * The real-world case: one RPC-style call, POST /_ah/api//orderendpoint/v1/getOrderHistory
 * (Google Cloud Endpoints, base URL ending in "/"), made by three API services
 * and two Lambdas, each with its own SDK learning state, so it arrived as
 * several templates.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 10, 1, 8, 0);
const NOW = START + 2 * DAY + HOUR;
const PROVIDER = 'OrderCo';
const HOST = 'cards.orderCo.example.test';

const TARGET = '/_ah/api/orderendpoint/v1/getOrderHistory';
/** What each caller sends for the same call. */
const SERVICES: [service: string, endpoint: string][] = [
  ['card-api', TARGET], // SDK 0.2.0 with the allowed word: right from the start
  ['payments-api', '/:id/api/orderendpoint/v1/getOrderHistory'], // 0.1.0: `_ah` unknown
  ['ledger-api', '/:id/api/:id/v1/getOrderHistory'], // 0.1.0 before the allowed word
  ['statement-lambda', '/:id/api/:id/:id/v1/getOrderHistory'], // 0.1.0, base URL ending in "/"
];
/** Other calls of the same provider that must stay as they are. */
const OTHERS: [string, string][] = [
  ['card-api', '/_ah/api/orderendpoint/v1/getBalance'],
  ['card-api', '/_ah/api/orderendpoint/v1/:id'], // a position learned as ID: many methods
];
const GAP_ROW = '/:id/api/:id/:id/v1/getOrderHistory';

let t: TestApp;
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });

async function ingest(at: number, rows: [string, string][], n = 3, failing = false) {
  t.clock.set(at + 1000);
  for (const [service, endpoint] of rows) {
    const events: CallEvent[] = Array.from({ length: n }, (_, i) =>
      event({
        ts: at + i * 100,
        provider: PROVIDER,
        host: HOST,
        method: 'POST',
        endpoint,
        ...(failing && i === 0
          ? { status: 503, outcome: 'http_5xx' as const, providerRequestId: `req_${service}_${at}` }
          : {}),
      }),
    );
    const res = await t.app.inject(ingestRequest(batch(events, { service })));
    expect(res.statusCode).toBe(202);
  }
}

/** POST rows of the provider: endpoint → calls, over all history. */
async function rows(): Promise<Record<string, number>> {
  const r = await t.db.pool.query(
    `SELECT endpoint, sum(total)::int AS calls FROM rollups_1m
      WHERE org_id = $1 AND project_id = $2 AND provider = $3 AND method = 'POST'
      GROUP BY endpoint ORDER BY endpoint`,
    [t.orgId, t.projectId, PROVIDER],
  );
  return Object.fromEntries(r.rows.map((x) => [x.endpoint, x.calls]));
}
const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

async function provider() {
  return (await t.db.storage.config.listProviders(tenant())).find((p) => p.name === PROVIDER)!;
}

const admin = (method: 'GET' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    ...(payload ? { payload } : {}),
  });

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(START) });
  await t.db.storage.events.ensurePartitions(new Date(START), 4);
  // two days of traffic, a few minutes an hour, from every caller
  for (let h = 0; h < 48; h += 6)
    for (let m = 0; m < 3; m++) await ingest(START + h * HOUR + m * MIN, [...SERVICES, ...OTHERS]);
  // and failures in the last minutes, from the caller that hadn't learned the provider word
  for (let m = 6; m >= 1; m--) await ingest(NOW - m * MIN, [SERVICES[2]!, SERVICES[0]!], 4, m <= 3);
  // rows from before the collector collapsed slashes (an SDK 0.1.0 without the learner)
  await t.db.storage.rollups.upsert(tenant(), [
    {
      environment: 'production',
      provider: PROVIDER,
      endpoint: '/_ah/api//orderendpoint/v1/getOrderHistory',
      method: 'POST',
      minute: new Date(START + 5 * MIN).toISOString(),
      total: 7,
      ok: 7,
      outcomes: { ...(await zeroOutcomes()), ok: 7 },
      status429: 0,
      latencyHistogram: emptyHistogram(),
      latencySumMs: 700,
    },
  ]);
  t.clock.set(NOW);
}, 120_000);
afterAll(async () => t.close());

async function zeroOutcomes() {
  const { OUTCOMES } = await import('@theirside/shared');
  return Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<
    (typeof OUTCOMES)[number],
    number
  >;
}

describe('one call, one row', () => {
  let before: Record<string, number>;
  let incidentId: string;

  it('starts with the call spread over several rows', async () => {
    before = await rows();
    expect(Object.keys(before).sort()).toEqual(
      [
        '/:id/api/:id/:id/v1/getOrderHistory',
        '/:id/api/:id/v1/getOrderHistory',
        '/:id/api/orderendpoint/v1/getOrderHistory',
        '/_ah/api//orderendpoint/v1/getOrderHistory',
        '/_ah/api/orderendpoint/v1/:id',
        '/_ah/api/orderendpoint/v1/getBalance',
        TARGET,
      ].sort(),
    );
  });

  it('ingest collapses repeated slashes from SDKs before 0.2.0', async () => {
    await ingest(
      NOW - 30_000,
      [['statement-lambda', '/_ah/api//orderendpoint/v1/getOrderHistory']],
      1,
    );
    t.clock.set(NOW);
    const r = await rows();
    expect(r[TARGET]).toBe(before[TARGET]! + 1);
    before = r;
  });

  it('the hourly job merges what it can without the provider word', async () => {
    const tx = tenant();
    // an open incident on the row that will merge later, with baselines for both
    const t0 = resolveThresholds(await t.db.storage.config.getThresholds(tx));
    const key = (endpoint: string) => ({
      environment: 'production',
      provider: PROVIDER,
      method: 'POST',
      endpoint,
    });
    await refreshBaselines(
      t.db.storage,
      tx,
      [key(TARGET), key('/:id/api/:id/v1/getOrderHistory')],
      new Date(NOW),
      t0,
    );
    incidentId = 'inc_merge_test';
    const incident: Incident = {
      ...tx,
      id: incidentId,
      environment: 'production',
      provider: PROVIDER,
      scope: 'provider',
      kind: 'errors',
      status: 'open',
      openedAt: new Date(NOW - 3 * MIN),
      resolvedAt: null,
      lastAlertedRate: 0.25,
      lastAlertedP95Ms: null,
      lastEvaluatedMinute: new Date(NOW - MIN),
      alertsMuted: false,
      windowMinutes: 5,
      peakErrorRate: 0.25,
      peakP95Ms: null,
      baseline: {},
      summary: '',
      sampleRequestIds: [],
      endpoints: [
        {
          endpoint: '/:id/api/:id/v1/getOrderHistory',
          method: 'POST',
          firstSeenAt: new Date(NOW - 3 * MIN),
          recoveredAt: null,
          peakErrorRate: 0.25,
        },
        {
          endpoint: TARGET,
          method: 'POST',
          firstSeenAt: new Date(NOW - 2 * MIN),
          recoveredAt: new Date(NOW - MIN),
          peakErrorRate: 0.1,
        },
      ],
    };
    await t.db.storage.incidents.create(incident);
    // a resolved one from yesterday, on a row the job merges now
    await t.db.storage.incidents.create({
      ...incident,
      id: 'inc_merge_old',
      scope: 'endpoint',
      status: 'resolved',
      openedAt: new Date(NOW - DAY),
      resolvedAt: new Date(NOW - DAY + 20 * MIN),
      endpoints: [
        {
          endpoint: '/:id/api/orderendpoint/v1/getOrderHistory',
          method: 'POST',
          firstSeenAt: new Date(NOW - DAY),
          recoveredAt: new Date(NOW - DAY + 20 * MIN),
          peakErrorRate: 0.4,
        },
      ],
    });

    await endpointMergeJob(t.db.storage, []).run(new Date(NOW));
    const old = (await t.db.storage.incidents.get(tx, 'inc_merge_old'))!;
    expect(old.endpoints.map((e) => [e.endpoint, e.peakErrorRate])).toEqual([[TARGET, 0.4]]);
    const r = await rows();
    // `_ah` is a Cloud Endpoints word; the `//` row is the collapsed one
    expect(r['/:id/api/orderendpoint/v1/getOrderHistory']).toBeUndefined();
    expect(r['/_ah/api//orderendpoint/v1/getOrderHistory']).toBeUndefined();
    // orderendpoint isn't allowed yet: the ledger row stays
    expect(r['/:id/api/:id/v1/getOrderHistory']).toBe(before['/:id/api/:id/v1/getOrderHistory']);
    expect(r[TARGET]).toBe(
      before[TARGET]! +
        before['/:id/api/orderendpoint/v1/getOrderHistory']! +
        before['/_ah/api//orderendpoint/v1/getOrderHistory']!,
    );
    expect(total(r)).toBe(total(before));
  });

  it('adding the allowed word merges the rest, history included', async () => {
    const p = await provider();
    const res = await admin('PATCH', `/v1/admin/providers/${p.id}`, {
      allowedPathWords: ['orderendpoint'],
    });
    expect(res.statusCode).toBe(200);
    const r = await rows();
    expect(Object.keys(r).sort()).toEqual(
      [
        GAP_ROW, // SDK 0.1.0 history: not merged
        '/_ah/api/orderendpoint/v1/:id', // stands for several methods
        '/_ah/api/orderendpoint/v1/getBalance',
        TARGET,
      ].sort(),
    );
    expect(r[TARGET]).toBe(
      total(before) -
        r[GAP_ROW]! -
        r['/_ah/api/orderendpoint/v1/:id']! -
        r['/_ah/api/orderendpoint/v1/getBalance']!,
    );
    expect(total(r)).toBe(total(before));
    // every minute of history moved, not only recent ones
    const oldest = await t.db.pool.query(
      `SELECT min(minute) AS m FROM rollups_1m WHERE provider = $1 AND endpoint = $2`,
      [PROVIDER, TARGET],
    );
    expect(new Date(oldest.rows[0].m).getTime()).toBe(START);
    expect(res.json().endpointAliases).toMatchObject({
      'POST /:id/api/:id/v1/getOrderHistory': TARGET,
      'POST /:id/api/orderendpoint/v1/getOrderHistory': TARGET,
    });
  });

  it('moves the open incident and the raw events, and recomputes baselines', async () => {
    const inc = (await t.db.storage.incidents.get(tenant(), incidentId))!;
    expect(inc.status).toBe('open');
    expect(inc.scope).toBe('endpoint');
    expect(inc.endpoints).toEqual([
      expect.objectContaining({
        endpoint: TARGET,
        firstSeenAt: new Date(NOW - 3 * MIN),
        recoveredAt: null, // still failing on the merged row
        peakErrorRate: 0.25,
      }),
    ]);
    const ev = await t.db.pool.query(
      `SELECT DISTINCT endpoint FROM events WHERE provider = $1 AND provider_request_id IS NOT NULL`,
      [PROVIDER],
    );
    expect(ev.rows.map((x) => x.endpoint)).toEqual([TARGET]);
    const baselines = (await t.db.storage.incidents.getBaselines(tenant())).filter(
      (b) => b.provider === PROVIDER && b.method === 'POST',
    );
    expect(baselines.map((b) => b.endpoint)).toEqual([TARGET]);
    const r = await rows();
    // the baseline window ends 15 minutes before now: the recent minutes don't count
    expect(baselines[0]!.sampleSize).toBeGreaterThan(r[TARGET]! - 60);
    expect(baselines[0]!.sampleSize).toBeLessThanOrEqual(r[TARGET]!);
  });

  it('the health report shows one row for the call', async () => {
    const o = (
      await admin('GET', `/v1/admin/overview?provider=${encodeURIComponent(PROVIDER)}&range=7d`)
    ).json();
    const eps = o.providers[0].endpoints.map((e: { endpoint: string }) => e.endpoint);
    expect(eps.filter((e: string) => e.endsWith('getOrderHistory'))).toEqual([TARGET, GAP_ROW]);
  });

  it('pushes routes so SDKs send the merged template', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/sdk-config',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    const orderCo = res.json().providers.find((p: { name: string }) => p.name === PROVIDER);
    expect(orderCo.routes).toContain(TARGET);
    // no doubled-slash routes: SDK 0.1.1+ collapses slashes itself
    expect(orderCo.routes.filter((r: string) => r.includes('//'))).toEqual([]);
    expect(orderCo.routes).not.toContain('/_ah/api/orderendpoint/v1/:id');
    expect(orderCo.allowedWords).toEqual(['orderendpoint']);
  });

  it('old templates still sent by SDKs land on the merged row', async () => {
    const r0 = await rows();
    await ingest(NOW + 10_000, [SERVICES[1]!, SERVICES[2]!], 2);
    const r = await rows();
    expect(Object.keys(r).sort()).toEqual(Object.keys(r0).sort());
    expect(r[TARGET]).toBe(r0[TARGET]! + 4);
  });

  it('is idempotent', async () => {
    const r0 = await rows();
    const p0 = await provider();
    expect(await mergeEndpoints(t.db.storage, tenant(), new Date(NOW))).toEqual([]);
    expect(
      await mergeEndpoints(t.db.storage, tenant(), new Date(NOW), { provider: PROVIDER }),
    ).toEqual([]);
    expect(await rows()).toEqual(r0);
    const p = await provider();
    expect(p.explicitRoutes).toEqual(p0.explicitRoutes);
    expect(p.endpointAliases).toEqual(p0.endpointAliases);
  });
});

describe('endpoint merge transaction', () => {
  it('a failure part-way leaves every row as it was', async () => {
    const other = 'Rollback Co';
    t.clock.set(NOW + 20_000);
    const res = await t.app.inject(
      ingestRequest(
        batch(
          ['/_ah/api/orderendpoint/v1/list', '/:id/api/orderendpoint/v1/list'].map((endpoint) =>
            event({ ts: NOW + 10_000, provider: other, host: 'rb.test', endpoint }),
          ),
        ),
      ),
    );
    expect(res.statusCode).toBe(202);
    const snapshot = async () =>
      (
        await t.db.pool.query(
          `SELECT endpoint, sum(total)::int AS n FROM rollups_1m WHERE provider = $1
            GROUP BY endpoint ORDER BY endpoint`,
          [other],
        )
      ).rows;
    const before = await snapshot();
    expect(before).toHaveLength(2);
    // the events step fails, after the rollups have moved
    await t.db.pool.query(`
      CREATE FUNCTION fail_merge() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$;
      CREATE TRIGGER fail_merge BEFORE UPDATE ON events FOR EACH STATEMENT EXECUTE FUNCTION fail_merge();`);
    try {
      await expect(
        mergeEndpoints(t.db.storage, tenant(), new Date(NOW), { provider: other }),
      ).rejects.toThrow(/simulated failure/);
      expect(await snapshot()).toEqual(before);
      const p = (await t.db.storage.config.listProviders(tenant())).find((x) => x.name === other)!;
      expect(p.endpointAliases).toEqual({});
      expect(p.explicitRoutes).toEqual([]);
    } finally {
      await t.db.pool.query(`DROP TRIGGER fail_merge ON events; DROP FUNCTION fail_merge();`);
    }
    // and it goes through once the failure is gone
    await mergeEndpoints(t.db.storage, tenant(), new Date(NOW), { provider: other });
    expect((await snapshot()).map((r) => r.endpoint)).toEqual(['/_ah/api/orderendpoint/v1/list']);
  });
});

describe('migration 011', () => {
  it('drops the doubled-slash routes 0.2.2 generated and keeps the rest', async () => {
    const { default: pg } = await import('pg');
    const { mkdtemp, cp, readdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { MIGRATIONS_DIR, migrate } = await import('../src/storage/migrate.js');
    const { randomBase62 } = await import('../src/util/ids.js');
    const { ADMIN_DATABASE_URL } = await import('./helpers.js');
    const name = `theirside_t_${randomBase62(10).toLowerCase()}`;
    const root = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
    await root.connect();
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_DATABASE_URL);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    const before = await mkdtemp(join(tmpdir(), 'theirside-migrations-'));
    try {
      for (const f of await readdir(MIGRATIONS_DIR))
        if (f < '011') await cp(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(pool, before);
      await pool.query(`INSERT INTO orgs (id, name) VALUES ('org_1', 'Org')`);
      await pool.query(`INSERT INTO projects (id, org_id, name) VALUES ('prj_1', 'org_1', 'P')`);
      await pool.query(
        `INSERT INTO providers (id, org_id, project_id, name, explicit_routes) VALUES
           ('prv_a', 'org_1', 'prj_1', 'OrderCo', ARRAY['/_ah/api/orders/v1/x', '/_ah/api//orders/v1/x', '/_ah/api/orders//v1/x']),
           ('prv_b', 'org_1', 'prj_1', 'Acme', ARRAY['/v1/users/:id'])`,
      );
      expect((await migrate(pool))[0]).toBe('011_drop_doubled_slash_routes.sql');
      const { rows } = await pool.query(
        `SELECT name, explicit_routes FROM providers ORDER BY name`,
      );
      expect(rows).toEqual([
        { name: 'Acme', explicit_routes: ['/v1/users/:id'] },
        { name: 'OrderCo', explicit_routes: ['/_ah/api/orders/v1/x'] },
      ]);
    } finally {
      await pool.end();
      await rm(before, { recursive: true, force: true });
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    }
  });
});
