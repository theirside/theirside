import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallEvent } from '@theirside/shared';
import { inboundJob } from '../src/modules/incidents/inbound.js';
import { MAX_PENDING_CANDIDATES } from '../src/modules/ingest/route.js';
import { FakeClock } from '../src/util/clock.js';
import {
  THEIRSIDE_ADMIN_TOKEN,
  batch,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

/**
 * Webhook discovery: candidate routes reported by the SDK are stored and
 * listed, never scored, capped per project; an admin confirms one with a name
 * (then it is a declared route in the remote config), a member ignores one
 * (then the SDK is told to stop).
 */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Tuesday 2026-11-10 14:00 UTC. */
const NOW = Date.UTC(2026, 10, 10, 14, 0);
let t: TestApp;
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });
const admin = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(NOW) });
  await t.db.storage.events.ensurePartitions(new Date(NOW - 4 * DAY), 8);
  await t.db.storage.config.createAlertChannel(tenant(), {
    kind: 'webhook',
    name: 'test',
    config: { url: 'https://hooks.example.test/x', secret: 's' },
    enabled: true,
  });
});
afterAll(async () => {
  await t?.close();
});

const candidate = (at: number, o: Partial<CallEvent> = {}): CallEvent => ({
  ts: at,
  provider: 'orbitpay',
  host: 'inbound',
  method: 'POST',
  endpoint: '/webhooks/orbitpay',
  status: 200,
  durationMs: 30,
  outcome: 'ok',
  direction: 'inbound',
  candidate: true,
  count: 1,
  ...o,
});

async function send(at: number, events: CallEvent[]) {
  t.clock.set(at);
  const res = await t.app.inject(ingestRequest(batch(events, { service: 'billing' })));
  expect(res.statusCode).toBe(202);
}

async function listCandidates() {
  const res = await t.app.inject({
    method: 'GET',
    url: '/v1/admin/webhooks/candidates',
    headers: admin,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    candidates: {
      endpoint: string;
      suggestedName: string | null;
      status: string;
      provider: string | null;
      deliveriesPerDay: number;
      deliveries7d: number;
      firstSeenAt: string;
      lastSeenAt: string;
      lastService: string | null;
    }[];
    pending: number;
    maxPending: number;
  };
}

async function sdkConfig() {
  const res = await t.app.inject({
    method: 'GET',
    url: '/v1/sdk-config',
    headers: { authorization: ingestRequest({}).headers.authorization },
  });
  return res.json() as {
    webhookRoutes?: { path: string; provider: string }[];
    ignoredWebhookRoutes?: string[];
  };
}

describe('discovered webhook routes', () => {
  it('are stored with daily counts, apart from deliveries, rollups, sources and providers', async () => {
    const day1 = NOW - 2 * DAY;
    await send(day1, [candidate(day1, { count: 40 })]);
    await send(day1 + 60 * MIN, [candidate(day1 + 60 * MIN, { count: 20, status: 401 })]);
    await send(NOW - DAY, [candidate(NOW - DAY, { count: 60 })]);
    await send(NOW - 5 * MIN, [
      candidate(NOW - 5 * MIN, { count: 30 }),
      // nothing suggested: "unknown" is not a name
      candidate(NOW - 5 * MIN, { provider: 'unknown', endpoint: '/:id/pay', count: 3 }),
    ]);
    const { candidates, pending, maxPending } = await listCandidates();
    expect(maxPending).toBe(MAX_PENDING_CANDIDATES);
    expect(pending).toBe(2);
    const orbitpay = candidates.find((c) => c.endpoint === '/webhooks/orbitpay')!;
    expect(orbitpay).toMatchObject({
      suggestedName: 'orbitpay',
      status: 'pending',
      provider: null,
      deliveries7d: 150,
      deliveriesPerDay: 50, // 150 over the 3 days since it was first seen
      firstSeenAt: new Date(day1).toISOString(),
      lastSeenAt: new Date(NOW - 5 * MIN).toISOString(),
      lastService: 'billing',
    });
    expect(candidates.find((c) => c.endpoint === '/:id/pay')!.suggestedName).toBeNull();

    const raw = await t.db.pool.query(`SELECT count(*)::int AS n FROM events WHERE org_id = $1`, [
      t.orgId,
    ]);
    expect(raw.rows[0].n).toBe(0);
    const rollups = await t.db.storage.inbound.query(tenant(), {
      from: new Date(NOW - 7 * DAY),
      to: new Date(NOW + MIN),
    });
    expect(rollups).toEqual([]);
    expect(await t.db.storage.inbound.listSources(tenant())).toEqual([]);
    const providers = await t.db.storage.config.listProviders(tenant());
    expect(providers.map((p) => p.name)).not.toContain('orbitpay');
  });

  it('never open incidents or alerts, whatever they answer', async () => {
    for (let m = 30; m >= 1; m--)
      await send(NOW - m * MIN, [candidate(NOW - m * MIN, { status: 401, count: 100 })]);
    await inboundJob(t.db.storage, t.ctx.alerts, { publicUrl: 'https://x.example' }).run(
      new Date(NOW + 5000),
    );
    expect(await t.db.storage.incidents.list(tenant(), {})).toEqual([]);
    const alerts = await t.db.pool.query(
      `SELECT count(*)::int AS n FROM alert_deliveries WHERE org_id = $1`,
      [t.orgId],
    );
    expect(alerts.rows[0].n).toBe(0);
  });

  it(`at most ${MAX_PENDING_CANDIDATES} pending routes per project; known ones keep counting`, async () => {
    const at = NOW - 2 * MIN;
    const flood = Array.from({ length: MAX_PENDING_CANDIDATES + 30 }, (_, i) =>
      candidate(at, { provider: 'unknown', endpoint: `/events/flood-${'x'.repeat(i + 1)}` }),
    );
    await send(at, flood);
    const before = await listCandidates();
    expect(before.pending).toBe(MAX_PENDING_CANDIDATES);
    expect(before.candidates.length).toBe(MAX_PENDING_CANDIDATES);
    // a route already stored is still updated at the cap
    await send(NOW - MIN, [candidate(NOW - MIN, { count: 7 })]);
    const after = await listCandidates();
    expect(after.candidates.find((c) => c.endpoint === '/webhooks/orbitpay')!.deliveries7d).toBe(
      150 + 3000 + 7,
    );
    expect(after.candidates.length).toBe(MAX_PENDING_CANDIDATES);
  });

  it('a member ignores a route: the remote config tells the SDKs to stop', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/candidates/ignore',
      headers: admin,
      payload: { endpoint: '/:id/pay' },
    });
    expect(res.statusCode).toBe(200);
    expect((await sdkConfig()).ignoredWebhookRoutes).toEqual(['/:id/pay']);
    // ignoring frees room under the cap
    const { pending } = await listCandidates();
    expect(pending).toBe(MAX_PENDING_CANDIDATES - 1);
    const missing = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/candidates/ignore',
      headers: admin,
      payload: { endpoint: '/nope' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('an admin confirms a route with a name: a declared route from then on', async () => {
    const noName = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/candidates/confirm',
      headers: admin,
      payload: { endpoint: '/webhooks/orbitpay', provider: 'unknown' },
    });
    expect(noName.statusCode).toBe(400);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/candidates/confirm',
      headers: admin,
      payload: { endpoint: '/webhooks/orbitpay', provider: 'OrbitPay Payments' },
    });
    expect(res.statusCode).toBe(200);
    expect((await sdkConfig()).webhookRoutes).toEqual([
      { path: '/webhooks/orbitpay', provider: 'OrbitPay Payments' },
    ]);
    // the provider row exists (settings, alerts switch, thresholds)
    const providers = await t.db.storage.config.listProviders(tenant());
    expect(providers.find((p) => p.name === 'OrbitPay Payments')).toMatchObject({
      hostPatterns: [],
    });
    // what the SDK then sends is an ordinary delivery: stored and scored like any other
    await send(NOW, [
      {
        ...candidate(NOW, { provider: 'OrbitPay Payments' }),
        candidate: undefined,
        count: undefined,
      },
    ]);
    const [src] = await t.db.storage.inbound.listSources(tenant());
    expect(src).toMatchObject({ provider: 'OrbitPay Payments', endpoint: '/webhooks/orbitpay' });
    // a member can't ignore a confirmed route
    const ignore = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/candidates/ignore',
      headers: admin,
      payload: { endpoint: '/webhooks/orbitpay' },
    });
    expect(ignore.statusCode).toBe(409);
  });

  it('restore puts a route back to pending and out of the remote config', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/candidates/restore',
      headers: admin,
      payload: { endpoint: '/webhooks/orbitpay' },
    });
    expect(res.statusCode).toBe(200);
    expect((await sdkConfig()).webhookRoutes).toBeUndefined();
    const { candidates } = await listCandidates();
    expect(candidates.find((c) => c.endpoint === '/webhooks/orbitpay')).toMatchObject({
      status: 'pending',
      provider: null,
    });
  });

  it('pending routes not reported for 30 days age out; decided ones stay', async () => {
    await t.db.storage.inbound.pruneCandidates(new Date(NOW + 31 * DAY));
    const { candidates } = await listCandidates();
    expect(candidates.map((c) => [c.endpoint, c.status])).toEqual([['/:id/pay', 'ignored']]);
  });
});
