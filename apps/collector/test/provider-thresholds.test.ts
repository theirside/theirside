import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertJob, incidentJob } from '../src/modules/incidents/job.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import {
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  thresholdsFor,
} from '../src/modules/scoring/thresholds.js';
import { FakeClock } from '../src/util/clock.js';
import { Browser, PASSWORD, invite, setUp, tokenFrom } from './auth-helpers.js';
import { batch, event, ingestRequest, startTestApp, type TestApp } from './helpers.js';

describe('thresholdsFor: provider, then project, then defaults', () => {
  const project = resolveThresholds({ minCalls: 1000, openAfterMinutes: 5 });

  it('uses the provider override where there is one', () => {
    const t = thresholdsFor(project, { minCalls: 10, latencyDeltaMs: 250 });
    expect(t.minCalls).toBe(10); // provider
    expect(t.latencyDeltaMs).toBe(250); // provider
    expect(t.openAfterMinutes).toBe(5); // project
    expect(t.rateMultiplier).toBe(DEFAULT_THRESHOLDS.rateMultiplier); // default
  });

  it('ignores keys a provider may not override, and values out of range', () => {
    const t = thresholdsFor(project, {
      windowMinutes: 1,
      cooldownMinutes: 0,
      minCalls: 0,
      openAfterMinutes: 61,
      rateMultiplier: Number.NaN,
      rateDeltaPp: 2,
    });
    expect(t).toEqual(project);
  });

  it('never changes the project thresholds it was given', () => {
    const before = { ...project };
    thresholdsFor(project, { minCalls: 10 });
    expect(project).toEqual(before);
    expect(thresholdsFor(project, {})).toBe(project);
    expect(thresholdsFor(project, undefined)).toBe(project);
  });
});

const MIN = 60_000;
const START = Date.UTC(2026, 10, 6, 9, 0);

describe('incidents and scores read the provider overrides first', () => {
  let t: TestApp;
  let admin: Browser;
  let member: Browser;
  const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });
  const providerId = async (name: string) =>
    (await t.db.storage.config.listProviders(tenant())).find((p) => p.name === name)!.id;

  /** 10 calls a minute to each provider, half of them failing. */
  async function minute(m: number) {
    const base = START + m * MIN;
    const events = ['Quiet Pay', 'Quiet Ship'].flatMap((provider) =>
      Array.from({ length: 10 }, (_, i) =>
        event({
          ts: base + i * 1000,
          provider,
          host: `${provider.split(' ')[1]!.toLowerCase()}.test`,
          endpoint: '/v1/charge',
          ...(i % 2 === 0 ? { status: 503, outcome: 'http_5xx' as const } : {}),
        }),
      ),
    );
    t.clock.set(base + 50_000);
    expect((await t.app.inject(ingestRequest(batch(events)))).statusCode).toBe(202);
    t.clock.set(base + MIN + 5000);
  }

  beforeAll(async () => {
    t = await startTestApp({ clock: new FakeClock(START) });
    admin = await setUp(t);
    const inv = await invite(admin, 'mia@example.com');
    member = new Browser(t);
    await member.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      name: 'Mia',
      password: PASSWORD,
    });
    await minute(0);
    // the project needs 1000 calls in the window: neither provider qualifies on its own
    await t.db.storage.config.setThresholds(tenant(), { minCalls: 1000 });
  });
  afterAll(async () => t.close());

  it('a member may not change thresholds; an admin may, within the limits', async () => {
    const id = await providerId('Quiet Pay');
    const url = `/v1/admin/providers/${id}`;
    const denied = await member.req('PATCH', url, { thresholds: { minCalls: 10 } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('admin_only');
    // the dashboard sends the whole form: unchanged thresholds are fine for a member
    expect((await member.req('PATCH', url, { thresholds: {}, supportNotes: 'x' })).statusCode).toBe(
      200,
    );
    for (const bad of [
      { minCalls: 0 },
      { openAfterMinutes: 1.5 },
      { rateDeltaPp: 2 },
      { windowMinutes: 1 },
    ])
      expect(
        (await admin.req('PATCH', url, { thresholds: bad })).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    const ok = await admin.req('PATCH', url, { thresholds: { minCalls: 10, openAfterMinutes: 2 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().thresholds).toEqual({ minCalls: 10, openAfterMinutes: 2 });
    // a member saving the form with the admin's values unchanged, in any key order
    expect(
      (await member.req('PATCH', url, { thresholds: { openAfterMinutes: 2, minCalls: 10 } }))
        .statusCode,
    ).toBe(200);
  });

  it('the project thresholds API returns the effective values a provider override replaces', async () => {
    const res = await admin.req('GET', '/v1/admin/settings/thresholds');
    expect(res.json()).toMatchObject({
      thresholds: { minCalls: 1000 },
      effective: { minCalls: 1000, openAfterMinutes: DEFAULT_THRESHOLDS.openAfterMinutes },
    });
  });

  it('opens an incident only for the provider whose override allows it', async () => {
    const scheduler = new Scheduler(
      t.db.storage,
      t.clock,
      [
        incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: 'http://c.test' }),
        alertJob(t.ctx.alerts),
      ],
      { info() {}, error() {} },
    );
    const opened = async () =>
      (await t.db.storage.incidents.list(tenant(), { status: 'open' })).map((i) => i.provider);
    for (let m = 1; m <= 2; m++) {
      await minute(m);
      await scheduler.tick();
    }
    // 2 bad minutes are enough for Quiet Pay (its override), not yet for anything else
    await minute(3);
    await scheduler.tick();
    expect(await opened()).toEqual(['Quiet Pay']);
    for (let m = 4; m <= 8; m++) {
      await minute(m);
      await scheduler.tick();
    }
    // Quiet Ship has the same traffic, but the project needs 1000 calls
    expect(await opened()).toEqual(['Quiet Pay']);
  });

  it('scores each provider with its own thresholds', async () => {
    const o = (await admin.req('GET', '/v1/admin/overview')).json();
    const status = (name: string) =>
      o.providers.find((p: { name: string }) => p.name === name)?.endpoints[0]?.score as number;
    // 50 calls of the 1000 the project wants: the error penalty is scaled down
    expect(status('Quiet Ship')).toBeGreaterThan(90);
    expect(status('Quiet Pay')).toBeLessThan(60);
  });

  it('resetting to the project values is an empty set', async () => {
    const id = await providerId('Quiet Pay');
    const res = await admin.req('PATCH', `/v1/admin/providers/${id}`, { thresholds: {} });
    expect(res.json().thresholds).toEqual({});
  });
});
