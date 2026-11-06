import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallEvent } from '@theirside/shared';
import { randomBase62 } from '../src/util/ids.js';
import { statusPageData } from '../src/modules/status-page/data.js';
import { MIGRATIONS_DIR, migrate } from '../src/storage/migrate.js';
import { FakeClock } from '../src/util/clock.js';
import {
  ADMIN_DATABASE_URL,
  THEIRSIDE_ADMIN_TOKEN,
  TEST_API_KEY,
  batch,
  event,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 10, 1, 0, 0);
/** "Now" for the reads: three days and two hours after START. */
const NOW = START + 3 * DAY + 2 * HOUR;

const QUIET_CALL = START + HOUR + 17_000;
const LIVE_A = { method: 'GET', endpoint: '/v2/cards' };
const LIVE_B = { method: 'POST', endpoint: '/v2/cards/:id/activate' };
const IDLE_30M = { method: 'POST', endpoint: '/v2/cards/:id/refund' };
const IDLE_3H = { method: 'POST', endpoint: '/v2/cards/:id/freeze' };
const IDLE_2D = { method: 'DELETE', endpoint: '/v2/cards/:id' };

let t: TestApp;

async function ingest(at: number, events: CallEvent[], environment = 'production') {
  t.clock.set(at + 1000);
  const res = await t.app.inject(ingestRequest(batch(events, { environment })));
  expect(res.statusCode).toBe(202);
}

const acme = (at: number, ep: { method: string; endpoint: string }, n: number, failures = 0) =>
  Array.from({ length: n }, (_, i) =>
    event({
      ts: at + i * 100,
      ...ep,
      ...(i < failures ? { status: 503, outcome: 'http_5xx' as const } : {}),
    }),
  );

interface Ep {
  method: string;
  endpoint: string;
  status: string;
  score: number | null;
  callsPerMin: number;
  lastCallAt: string;
  rangeTotals: { calls: number; errorRate: number; p95Ms: number | null };
}
interface Prov {
  name: string;
  status: string;
  lastCallAt: string | null;
  callsPerMin: number;
  endpoints: Ep[];
}

async function overview(query: string) {
  const res = await t.app.inject({
    method: 'GET',
    url: `/v1/admin/overview?${query}`,
    headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { range: string; providers: Prov[] };
}
const endpointsOf = async (range: string) => {
  const o = await overview(`provider=${encodeURIComponent('Acme Cards')}&range=${range}`);
  expect(o.range).toBe(range);
  return o.providers.find((p) => p.name === 'Acme Cards')!.endpoints;
};
const iso = (ms: number) => new Date(ms).toISOString();
const minuteOf = (ms: number) => iso(Math.floor(ms / MIN) * MIN);

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(START) });
  await t.db.storage.events.ensurePartitions(new Date(START), 5);
  // a provider called once, three days ago
  await ingest(QUIET_CALL, [
    event({ ts: QUIET_CALL, provider: 'Quiet Co', host: 'quiet.test', endpoint: '/v1/ping' }),
  ]);
  // Acme: endpoints last called 2 days, 3 hours and 30 minutes ago, and two live ones
  await ingest(NOW - 2 * DAY, acme(NOW - 2 * DAY, IDLE_2D, 4, 4));
  await ingest(NOW - 3 * HOUR, acme(NOW - 3 * HOUR, IDLE_3H, 4, 1));
  await ingest(NOW - 30 * MIN, acme(NOW - 30 * MIN, IDLE_30M, 2));
  for (let m = 5; m >= 1; m--) {
    const at = Math.floor(NOW / MIN) * MIN - m * MIN;
    await ingest(at, [...acme(at, LIVE_A, 20), ...acme(at, LIVE_B, 5)]);
  }
  // configured, never called
  await t.db.storage.config.upsertProvider(
    { orgId: t.orgId, projectId: t.projectId },
    {
      name: 'Never Co',
      hostPatterns: ['never.test'],
      explicitRoutes: [],
      supportEmail: null,
      supportUrl: null,
      supportNotes: null,
      publicDisplayName: null,
      isPublic: false,
    },
  );
  t.clock.set(NOW);
}, 60_000);
afterAll(async () => t.close());

describe('provider page: endpoints within the range', () => {
  it('lists live endpoints by calls/min, then idle ones by last call', async () => {
    const eps = await endpointsOf('24h');
    expect(eps.map((e) => [e.method, e.endpoint, e.status])).toEqual([
      ['GET', LIVE_A.endpoint, 'green'],
      ['POST', LIVE_B.endpoint, 'green'],
      ['POST', IDLE_30M.endpoint, 'idle'],
      ['POST', IDLE_3H.endpoint, 'idle'],
    ]);
    expect(eps[0]).toMatchObject({ callsPerMin: 20, score: 100 });
    expect(eps[1]).toMatchObject({ callsPerMin: 5 });
  });

  it('idle rows carry the last call and range totals, never a score', async () => {
    const eps = await endpointsOf('24h');
    const freeze = eps.find((e) => e.endpoint === IDLE_3H.endpoint)!;
    expect(freeze).toMatchObject({
      status: 'idle',
      score: null,
      callsPerMin: 0,
      lastCallAt: minuteOf(NOW - 3 * HOUR),
      rangeTotals: { calls: 4, errorRate: 0.25 },
    });
    expect(freeze.rangeTotals.p95Ms).toBeGreaterThan(0);
    // live rows have them too
    expect(eps[0]!.rangeTotals.calls).toBe(100);
    expect(eps[0]!.lastCallAt).toBe(minuteOf(NOW - MIN));
  });

  it('an idle endpoint that only failed is still idle, not red', async () => {
    const eps = await endpointsOf('7d');
    const closed = eps.find((e) => e.endpoint === IDLE_2D.endpoint)!;
    expect(closed).toMatchObject({
      status: 'idle',
      score: null,
      rangeTotals: { calls: 4, errorRate: 1 },
    });
    const prov = (await overview('provider=Acme%20Cards&range=7d')).providers[0]!;
    expect(prov.status).toBe('green');
  });

  it('switching the range adds and removes idle endpoints', async () => {
    const names = async (range: string) => (await endpointsOf(range)).map((e) => e.endpoint);
    expect(await names('1h')).toEqual([LIVE_A.endpoint, LIVE_B.endpoint, IDLE_30M.endpoint]);
    expect(await names('24h')).toEqual([
      LIVE_A.endpoint,
      LIVE_B.endpoint,
      IDLE_30M.endpoint,
      IDLE_3H.endpoint,
    ]);
    expect(await names('7d')).toEqual([
      LIVE_A.endpoint,
      LIVE_B.endpoint,
      IDLE_30M.endpoint,
      IDLE_3H.endpoint,
      IDLE_2D.endpoint,
    ]);
  });

  it('a quiet endpoint stays listed as the scoring window moves on', async () => {
    // ten minutes later the live endpoints are quiet too: all idle, none gone
    t.clock.set(NOW + 10 * MIN);
    try {
      const o = await overview('provider=Acme%20Cards&range=1h');
      const p = o.providers[0]!;
      expect(p.endpoints.map((e) => [e.endpoint, e.status])).toEqual([
        [LIVE_A.endpoint, 'idle'],
        [LIVE_B.endpoint, 'idle'],
        [IDLE_30M.endpoint, 'idle'],
      ]);
      expect(p).toMatchObject({ status: 'idle', callsPerMin: 0 });
      expect(p.lastCallAt! >= minuteOf(NOW - MIN)).toBe(true);
    } finally {
      t.clock.set(NOW);
    }
  });

  it('only returns the provider asked for, and rejects an unknown range', async () => {
    const o = await overview('provider=Acme%20Cards&range=1h');
    expect(o.providers.map((p) => p.name)).toEqual(['Acme Cards']);
    const bad = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/overview?range=30d',
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('providers list', () => {
  it('keeps a provider quiet for longer than the range, as idle with its last call', async () => {
    const o = await overview('');
    expect(o.range).toBe('24h');
    const byName = Object.fromEntries(o.providers.map((p) => [p.name, p]));
    expect(byName['Quiet Co']).toMatchObject({
      status: 'idle',
      callsPerMin: 0,
      lastCallAt: iso(QUIET_CALL), // from the provider row, to the second
      endpoints: [],
    });
    expect(byName['Never Co']).toMatchObject({ status: 'unknown', lastCallAt: null });
    // live first, then idle, then never called
    expect(o.providers.map((p) => p.name)).toEqual(['Acme Cards', 'Quiet Co', 'Never Co']);
  });

  it('within the range, the quiet provider lists its endpoint as idle', async () => {
    const o = await overview('range=7d');
    const quiet = o.providers.find((p) => p.name === 'Quiet Co')!;
    expect(quiet.endpoints).toMatchObject([
      { endpoint: '/v1/ping', status: 'idle', lastCallAt: minuteOf(QUIET_CALL) },
    ]);
  });

  it('with an environment filter, uses only that environment', async () => {
    const o = await overview('environment=staging');
    for (const p of o.providers) expect(p).toMatchObject({ status: 'unknown', lastCallAt: null });
  });

  it('shows idle as "no data" on the status page, never operational', async () => {
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const quiet = (await t.db.storage.config.listProviders(tenant)).find(
      (p) => p.name === 'Quiet Co',
    )!;
    await t.db.storage.config.updateProvider(tenant, quiet.id, { isPublic: true });
    const page = (await t.db.storage.config.listStatusPages(tenant))[0]!;
    const data = await statusPageData(t.db.storage, page, t.clock.now());
    expect(data.providers.find((p) => p.name === 'Quiet Co')!.status).toBe('no_data');
  });
});

describe('GET /v1/health', () => {
  const health = (query = '') =>
    t.app.inject({
      method: 'GET',
      url: `/v1/health${query}`,
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });

  it('lists every provider and the endpoints of the last 24 h by default', async () => {
    const h = (await health()).json();
    expect(h.range).toBe('24h');
    expect(h.providers.map((p: Prov) => [p.name, p.status])).toEqual([
      ['Acme Cards', 'green'],
      ['Quiet Co', 'idle'],
      ['Never Co', 'unknown'],
    ]);
    const acmeEps = h.providers[0].endpoints as Ep[];
    expect(acmeEps.filter((e) => e.status === 'idle').map((e) => e.endpoint)).toEqual([
      IDLE_30M.endpoint,
      IDLE_3H.endpoint,
    ]);
  });

  it('takes a range and rejects unknown ones', async () => {
    const h = (await health('?range=7d')).json();
    expect(h.providers[0].endpoints.map((e: Ep) => e.endpoint)).toContain(IDLE_2D.endpoint);
    expect((await health('?range=1y')).statusCode).toBe(400);
  });
});

describe('provider last call', () => {
  const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });
  const lastCall = async (name: string) =>
    (await t.db.storage.config.listProviders(tenant())).find((p) => p.name === name)!.lastCallAt;

  it('only moves forward, and at most every 30 seconds', async () => {
    const at = new Date(QUIET_CALL);
    const store = t.db.storage.config;
    await store.touchProviders(tenant(), new Map([['Quiet Co', new Date(QUIET_CALL - HOUR)]]));
    expect(await lastCall('Quiet Co')).toEqual(at);
    await store.touchProviders(tenant(), new Map([['Quiet Co', new Date(QUIET_CALL + 10_000)]]));
    expect(await lastCall('Quiet Co')).toEqual(at);
    await store.touchProviders(tenant(), new Map([['Quiet Co', new Date(QUIET_CALL + 31_000)]]));
    expect(await lastCall('Quiet Co')).toEqual(new Date(QUIET_CALL + 31_000));
  });

  it('a merge keeps the later last call', async () => {
    const store = t.db.storage.config;
    const list = await store.listProviders(tenant());
    const quiet = list.find((p) => p.name === 'Quiet Co')!;
    const never = list.find((p) => p.name === 'Never Co')!;
    const merged = await store.absorbProvider(tenant(), quiet.id, never.id);
    expect(merged!.lastCallAt).toEqual(quiet.lastCallAt);
  });
});

describe('migration 008', () => {
  it('fills the last call of existing providers from rollups', async () => {
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
        if (f < '008') await cp(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(pool, before);
      await pool.query(`INSERT INTO orgs (id, name) VALUES ('org_1', 'Org')`);
      await pool.query(`INSERT INTO projects (id, org_id, name) VALUES ('prj_1', 'org_1', 'P')`);
      await pool.query(
        `INSERT INTO providers (id, org_id, project_id, name) VALUES
           ('prv_a', 'org_1', 'prj_1', 'Called'), ('prv_b', 'org_1', 'prj_1', 'Silent')`,
      );
      await pool.query(
        `INSERT INTO rollups_1m (org_id, project_id, environment, provider, endpoint, method, minute, total)
         VALUES ('org_1', 'prj_1', 'production', 'Called', '/a', 'GET', '2026-11-01T10:00:00Z', 3),
                ('org_1', 'prj_1', 'staging', 'Called', '/b', 'GET', '2026-11-02T08:30:00Z', 1)`,
      );
      expect((await migrate(pool))[0]).toBe('008_provider_last_call.sql');
      const { rows } = await pool.query(`SELECT name, last_call_at FROM providers ORDER BY name`);
      expect(rows).toEqual([
        { name: 'Called', last_call_at: new Date('2026-11-02T08:30:00Z') },
        { name: 'Silent', last_call_at: null },
      ]);
    } finally {
      await pool.end();
      await rm(before, { recursive: true, force: true });
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    }
  });
});
