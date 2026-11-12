import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { createContext } from '../src/context.js';
import { buildApp } from '../src/server.js';
import { attachSim } from '../src/sim/app.js';
import { main as simCli } from '../src/sim/cli.js';
import { SimClock } from '../src/sim/clock.js';
import type { SimEngine } from '../src/sim/engine.js';
import {
  SIM_META_KEY,
  SimGuardError,
  checkSimDatabase,
  resetSimDatabase,
} from '../src/sim/guard.js';
import { scenarioToYaml, validateScenario } from '../src/sim/scenario.js';
import { systemClock } from '../src/util/clock.js';
import {
  ADMIN_DATABASE_URL,
  THEIRSIDE_ADMIN_TOKEN,
  createTestDb,
  startTestApp,
  testConfig,
  type TestApp,
  type TestDb,
} from './helpers.js';

/** A short scenario: 2 days of history, then a 5xx fault 40 minutes in. */
const scenario = {
  name: 'unit-scenario',
  start: '2026-01-05T08:00:00Z',
  duration: '2h',
  seed: 1,
  history: { mode: 'seeded', days: 2 },
  providers: [
    {
      name: 'PayCo',
      host: 'api.payco.test',
      endpoints: [
        { method: 'POST', path: '/v1/charges', traffic: { pattern: 'steady', rate: 40 } },
      ],
    },
  ],
  // an hour of history per transaction touches the webhook source many times
  webhooks: [
    { provider: 'NotifyCo', route: '/webhooks/notifyco', traffic: { pattern: 'steady', rate: 5 } },
  ],
  faults: [
    {
      id: 'outage',
      target: 'PayCo POST /v1/charges',
      at: '+40m',
      duration: '30m',
      type: '5xx',
      size: 0.6,
    },
  ],
  expect: [
    { incident: { kind: 'errors', fault: 'outage', within: '10m' } },
    // deliberately wrong: the outage falls inside this window
    { quiet: { from: 'day 0 00:00', to: 'day 0 01:30' } },
  ],
};

describe('simulation databases (guards)', () => {
  let empty: TestDb;
  let used: TestApp;
  beforeAll(async () => {
    empty = await createTestDb();
    used = await startTestApp();
  });
  afterAll(async () => {
    await empty?.drop();
    await used?.close();
  });

  it('marks an empty database on its first start in simulation mode, then accepts it', async () => {
    expect(await checkSimDatabase(empty.pool, true)).toBe('marked');
    expect(await checkSimDatabase(empty.pool, true)).toBe('ok');
    const { rows } = await empty.pool.query('SELECT 1 FROM install_meta WHERE key = $1', [
      SIM_META_KEY,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('a normal collector refuses a simulation database', async () => {
    await expect(checkSimDatabase(empty.pool, false)).rejects.toBeInstanceOf(SimGuardError);
  });

  it('simulation mode refuses a database holding other data, and reset refuses it too', async () => {
    await expect(checkSimDatabase(used.db.pool, true)).rejects.toThrow(/not a simulation database/);
    await expect(resetSimDatabase(used.db.pool)).rejects.toThrow(/not a simulation database/);
    // a normal start on it is unaffected
    expect(await checkSimDatabase(used.db.pool, false)).toBe('ok');
  });

  it('every /__sim route is a 404 outside simulation mode', async () => {
    for (const [method, url] of [
      ['GET', '/__sim/clock'],
      ['PUT', '/__sim/clock'],
      ['POST', '/__sim/clock/advance'],
      ['DELETE', '/__sim/clock/advance'],
      ['GET', '/__sim/state'],
      ['GET', '/__sim/reference'],
      ['POST', '/__sim/load'],
    ] as const) {
      const r = await used.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
      });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    const status = await used.app.inject({ method: 'GET', url: '/v1/auth/status' });
    expect(status.json().simulation).toBe(false);
  });
});

describe('simulation mode (engine, API, runner)', () => {
  let db: TestDb;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let engine: SimEngine;
  let clock: SimClock;
  beforeAll(async () => {
    process.env.THEIRSIDE_SIM_ALERT_URL = 'off';
    db = await createTestDb();
    await checkSimDatabase(db.pool, true);
    const config = testConfig(db.url, { THEIRSIDE_SIM: '1' });
    clock = new SimClock(Date.UTC(2026, 0, 5));
    const ctx = createContext(config, db.storage, { clock, wallClock: systemClock });
    await bootstrap(db.storage, {
      apiKey: config.bootstrapApiKey,
      generateKey: false,
      orgName: config.bootstrapOrgName,
      projectName: config.bootstrapProjectName,
      entitlements: ctx.entitlements,
    });
    app = await buildApp(ctx, { logger: false });
    ({ engine } = await attachSim(app, ctx, db.pool, config, clock));
  });
  afterAll(async () => {
    await engine?.stop();
    await app?.close();
    await db?.drop();
  });

  const admin = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };

  it('serves the clock API to admins only', async () => {
    expect((await app.inject({ method: 'GET', url: '/__sim/clock' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url: '/__sim/clock', headers: admin });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ paused: true, status: 'idle' });
    const status = await app.inject({ method: 'GET', url: '/v1/auth/status' });
    expect(status.json().simulation).toBe(true);
  });

  it('runs a scenario minute by minute: the expected incident passes, the wrong expectation fails', async () => {
    const load = await app.inject({
      method: 'POST',
      url: '/__sim/load',
      headers: admin,
      payload: { scenario },
    });
    expect(load.statusCode).toBe(200);
    expect(load.json()).toMatchObject({ now: '2026-01-05T08:00:00.000Z', status: 'ready' });
    await engine.runToEnd();
    const s = await engine.state();
    expect(s.status).toBe('finished');
    expect(s.now).toBeGreaterThanOrEqual(Date.parse('2026-01-05T10:00:00Z'));
    const opened = s.timeline.filter((e) => e.type === 'opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'errors', provider: 'PayCo' });
    expect(s.expectations.map((e) => e.status)).toEqual(['pass', 'fail']);
    // the incident is stored with simulated times
    const [inc] = await db.storage.incidents.list(
      {
        orgId: (await db.storage.config.listOrgs())[0]!.id,
        projectId: (
          await db.storage.config.listProjects((await db.storage.config.listOrgs())[0]!.id)
        )[0]!.id,
      },
      { limit: 5 },
    );
    expect(inc!.openedAt.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-01-05T08:40:00Z'));
    expect(inc!.openedAt.getTime()).toBeLessThan(Date.parse('2026-01-05T08:52:00Z'));
  });

  it('applies traffic and future-fault edits live, and asks for a restart for new sources', async () => {
    const edited = structuredClone(scenario);
    edited.providers[0]!.endpoints[0]!.traffic.rate = 80;
    const r = engine.applyLive(edited);
    expect(r, JSON.stringify(r)).toEqual({ applied: true, restartRequired: null });
    const more = structuredClone(scenario);
    more.providers[0]!.endpoints.push({
      method: 'GET',
      path: '/v1/charges/:id',
      traffic: { pattern: 'steady', rate: 10 },
    });
    expect(engine.applyLive(more)).toMatchObject({ applied: false, restartRequired: /sources/ });
  });

  it('jumps: shown as jumping, ends paused if it was paused, Play during it runs on after, can be stopped', async () => {
    const until = async (ok: (s: Awaited<ReturnType<SimEngine['state']>>) => boolean) => {
      for (let i = 0; i < 600; i++) {
        const s = await engine.state();
        if (ok(s)) return s;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('timed out');
    };
    const call = (method: 'POST' | 'DELETE' | 'PUT', url: string, payload?: object) =>
      app.inject({ method, url, headers: admin, payload });
    await call('POST', '/__sim/load', { scenario });
    const start = Date.parse('2026-01-05T08:00:00Z');

    // paused: jumping while it runs, then paused at the target
    const j = await call('POST', '/__sim/clock/advance', { minutes: 20 });
    expect(j.json()).toMatchObject({
      status: 'jumping',
      paused: true,
      jumpTo: '2026-01-05T08:20:00.000Z',
    });
    let s = await until((x) => x.status !== 'jumping');
    expect(s).toMatchObject({ status: 'paused', paused: true, jumpTo: null });
    expect(s.now).toBeGreaterThanOrEqual(start + 20 * 60_000);
    expect(s.now).toBeLessThan(start + 21 * 60_000);

    // Play during a jump: still jumping, then keeps running
    await call('POST', '/__sim/clock/advance', { minutes: 10 });
    const p = await call('PUT', '/__sim/clock', { paused: false });
    expect(p.json()).toMatchObject({ status: 'jumping', paused: false });
    s = await until((x) => x.status !== 'jumping');
    expect(s.status).toBe('running');
    await engine.pause();

    // stopped: back to paused before the target
    await call('POST', '/__sim/clock/advance', { minutes: 60 });
    const stop = await call('DELETE', '/__sim/clock/advance');
    expect(stop.json()).toMatchObject({ status: 'paused', jumpTo: null });
    expect((await engine.state()).now).toBeLessThan(start + 90 * 60_000);
  });

  it('the CLI exits non-zero when an expectation fails, zero when all pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-'));
    const failing = join(dir, 'failing.yaml');
    writeFileSync(failing, scenarioToYaml(validateScenario(scenario).scenario));
    const passing = join(dir, 'passing.yaml');
    writeFileSync(
      passing,
      scenarioToYaml(validateScenario({ ...scenario, expect: [scenario.expect[0]] }).scenario),
    );
    const url = new URL(ADMIN_DATABASE_URL);
    url.pathname = `/theirside_sim_cli_${Date.now().toString(36)}`;
    try {
      expect(
        await simCli([failing, '--port', '0', '--quiet', '--database-url', url.toString()]),
      ).toBe(1);
      expect(
        await simCli([passing, '--port', '0', '--quiet', '--database-url', url.toString()]),
      ).toBe(0);
    } finally {
      const a = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${url.pathname.slice(1)} WITH (FORCE)`);
      await a.end();
    }
  }, 120_000);
});
