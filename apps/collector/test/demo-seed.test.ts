import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_ALERT_SINK_NAME,
  DEMO_ENVIRONMENT,
  DemoSeedRefused,
  ensureDemoAlertSink,
  seedDemo,
  type SeedResult,
} from '../src/demo/seed.js';
import { FakeClock } from '../src/util/clock.js';
import {
  createTestDb,
  ingestRequest,
  startTestApp,
  batch,
  event,
  type TestApp,
  TEST_API_KEY,
} from './helpers.js';

const NOW = new Date('2026-11-04T12:00:30Z');
let t: TestApp;
let result: SeedResult;

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(NOW) });
  result = await seedDemo(t.db.storage, { now: NOW });
}, 120_000);
afterAll(async () => {
  await t.close();
});

describe('demo seed', () => {
  it('backfills a week per minute plus 30 days of history, incidents and baselines', () => {
    expect(result.seeded).toBe(true);
    // 9 endpoints × 7 × 1440 minutes (minus quiet minutes) + hourly rows for 23 days
    expect(result.rollupRows).toBeGreaterThan(50_000);
    expect(result.incidents).toBe(6);
    expect(result.events).toBeGreaterThan(0);
    expect(result.baselines).toBe(9);
  });

  it('dashboard health is past learning, with the noisy KYC endpoint at ~3% normal', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/v1/health?environment=${DEMO_ENVIRONMENT}`,
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const providers = res.json().providers as {
      name: string;
      endpoints: { endpoint: string; learning: boolean; normalErrorRate: number }[];
    }[];
    // the names auto-discovery gives the demo's hosts (NotifyCo: demo catalog override)
    expect(providers.map((p) => p.name).sort()).toEqual([
      'NotifyCo',
      'acmecards.test',
      'bankco.test',
      'kyco.test',
      'saasco.test',
    ]);
    const all = providers.flatMap((p) => p.endpoints);
    expect(all.every((e) => !e.learning)).toBe(true);
    const kyc = providers.find((p) => p.name === 'kyco.test')!.endpoints[0]!;
    expect(kyc.normalErrorRate).toBeGreaterThan(0.02);
    expect(kyc.normalErrorRate).toBeLessThan(0.04);
    // templates match what the zero-config demo app sends (collapsed IDs, no routes)
    expect(all.map((e) => e.endpoint)).toEqual(
      expect.arrayContaining([
        '/v2/cards/:id/activate',
        '/v2/cards/:id',
        '/v1/files/:id',
        '/v1/accounts/:id/balance',
        '/v1/workspace/sync',
      ]),
    );
  });

  it('has past incidents with paste-ready summaries', async () => {
    const incidents = await t.db.storage.incidents.list(
      { orgId: t.orgId, projectId: t.projectId },
      { limit: 50 },
    );
    expect(incidents).toHaveLength(6);
    expect(incidents.every((i) => i.status === 'resolved')).toBe(true);
    expect(incidents[0]!.summary).toMatch(/recovered at \d\d:\d\d UTC after \d+ min/);
    expect(incidents[0]!.summary).toMatch(/Sample provider request IDs: req_/);
  });

  it('status page has 30 days of history with incident days marked', async () => {
    const page = (
      await t.db.storage.config.listStatusPages({ orgId: t.orgId, projectId: t.projectId })
    )[0]!;
    const html = (await t.app.inject({ method: 'GET', url: `/status/${page.publicToken}` })).body;
    const bars = html.match(/class="bar (ok|degraded|outage|no_data)"/g) ?? [];
    // 3 public providers (NotifyCo and saasco.test are not public) × 30 days
    expect(bars.length).toBe(3 * 30);
    expect(bars.filter((b) => b.includes('no_data')).length).toBeLessThanOrEqual(3);
    expect(bars.some((b) => b.includes('degraded') || b.includes('outage'))).toBe(true);
  });

  it('live traffic lands on top of the seeded keys', async () => {
    const res = await t.app.inject(
      ingestRequest(
        batch(
          [
            event({
              ts: NOW.getTime(),
              provider: null,
              host: 'api.kyco.test:4010',
              method: 'POST',
              endpoint: '/v1/kyc/checks',
            }),
          ],
          { environment: DEMO_ENVIRONMENT },
        ),
      ),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1); // assigned to the seeded kyco.test, not a new provider
    const names = (
      await t.db.storage.config.listProviders({ orgId: t.orgId, projectId: t.projectId })
    ).map((p) => p.name);
    expect(names.filter((n) => n.includes('kyco'))).toEqual(['kyco.test']);
  });

  it('seeded providers are established, not "New", and never reach the discovery digest', async () => {
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const seeded = (await t.db.storage.config.listProviders(tenant)).filter(
      (p) => p.name !== 'kyco.test',
    );
    for (const p of seeded)
      expect(p.firstSeenAt.getTime()).toBeLessThan(NOW.getTime() - 29 * 86400_000);
    expect(await t.db.storage.config.takeUndigestedProviders(tenant)).toEqual([]);
  });

  it('seeds NotifyCo webhooks: silence is judged from the first minute, and goes off ~15 min after they stop', async () => {
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const [src] = await t.db.storage.inbound.listSources(tenant);
    expect(src).toMatchObject({
      provider: 'NotifyCo',
      endpoint: '/webhooks/notifyco',
      environment: 'demo',
    });
    const [b] = await t.db.storage.inbound.getBaselines(tenant);
    expect(b!.silence.historyHours).toBeGreaterThanOrEqual(7 * 24);
    expect(b!.silence.deliveries).toBeGreaterThan(100);
    const { judgeSilence } = await import('../src/modules/scoring/silence.js');
    const { DEFAULT_THRESHOLDS } = await import('../src/modules/scoring/thresholds.js');
    const last = Math.floor(NOW.getTime() / 60_000) * 60_000 - 60_000;
    expect(judgeSilence(b!.silence, last, last + 10 * 60_000, DEFAULT_THRESHOLDS)).toMatchObject({
      judged: true,
      bad: false,
    });
    expect(judgeSilence(b!.silence, last, last + 17 * 60_000, DEFAULT_THRESHOLDS)).toMatchObject({
      judged: true,
      bad: true,
    });
  });

  it('a second run is a no-op', async () => {
    expect((await seedDemo(t.db.storage, { now: NOW })).seeded).toBe(false);
  });

  it('adds the alert channel into the chaos sink once (docker/compose.demo.yml)', async () => {
    const sink = { url: 'http://chaos:4010/__alerts', secret: 'theirside-demo-sink-secret' };
    expect(await ensureDemoAlertSink(t.db.storage, sink)).toBe(true);
    expect(await ensureDemoAlertSink(t.db.storage, sink)).toBe(false);
    const channels = await t.db.storage.config.listAlertChannels({
      orgId: t.orgId,
      projectId: t.projectId,
    });
    expect(channels.filter((c) => c.name === DEMO_ALERT_SINK_NAME)).toEqual([
      expect.objectContaining({ kind: 'webhook', enabled: true, config: sink }),
    ]);
  });
});

describe('demo seed guards', () => {
  it('refuses a database with non-demo providers or old data', async () => {
    const db = await createTestDb();
    const app = await startTestApp({ db, clock: new FakeClock(NOW) });
    await db.storage.config.upsertProvider(
      { orgId: app.orgId, projectId: app.projectId },
      {
        name: 'Real Payments Inc',
        hostPatterns: ['api.realpayments.example'],
        explicitRoutes: [],
        supportEmail: null,
        supportUrl: null,
        supportNotes: null,
        publicDisplayName: null,
        isPublic: false,
      },
    );
    await expect(seedDemo(db.storage, { now: NOW })).rejects.toBeInstanceOf(DemoSeedRefused);
    await app.close();
    await db.drop();
  });

  it('refuses a database with data older than 2 hours', async () => {
    const db = await createTestDb();
    const app = await startTestApp({ db, clock: new FakeClock(NOW) });
    const old = NOW.getTime() - 3 * 3600_000;
    app.clock.set(old + 1000);
    await app.app.inject(ingestRequest(batch([event({ ts: old, provider: 'kyco.test' })])));
    await expect(seedDemo(db.storage, { now: NOW })).rejects.toThrow(/older than 2 hours/);
    await app.close();
    await db.drop();
  });
});
