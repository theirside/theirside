import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flush, getStats, init, shutdown } from '@theirside/sdk';
import { OTHER_PROVIDER } from '../src/modules/discovery/directory.js';
import { buildSdkConfig } from '../src/modules/discovery/sdk-config-route.js';
import type { ProviderInput } from '../src/storage/types.js';
import { alertJob, incidentJob } from '../src/modules/incidents/job.js';
import { partitionJob } from '../src/modules/scheduler/maintenance.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import { FakeClock } from '../src/util/clock.js';
import {
  batch,
  createTestDb,
  event,
  ingestRequest,
  startTestApp,
  TEST_API_KEY,
  type TestApp,
  type TestDb,
} from './helpers.js';

const discovered = (host: string, extra: Parameters<typeof event>[0] = {}) =>
  event({ provider: null, host, ...extra });

const providersOf = async (t: TestApp) =>
  new Map(
    (await t.db.storage.config.listProviders({ orgId: t.orgId, projectId: t.projectId })).map(
      (p) => [p.name, p],
    ),
  );

describe('collector: discovered hosts', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('groups hosts by registrable domain, names catalog providers, infrastructure without alerts', async () => {
    const t = await startTestApp({ db });
    const res = await t.app.inject(
      ingestRequest(
        batch([
          discovered('api.acmecards.test:4010', { endpoint: '/v2/cards/:id' }),
          discovered('files.acmecards.test:4010', { endpoint: '/v1/files/:id' }),
          discovered('sandbox.acmecards.test:4010'),
          discovered('api.kyco.test'),
          discovered('api.stripe.com', { endpoint: '/v1/charges' }),
          discovered('my-bucket.s3.eu-west-1.amazonaws.com', { endpoint: '/:id' }),
        ]),
      ),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(6);
    const ps = await providersOf(t);
    expect(ps.get('acmecards.test')).toMatchObject({
      source: 'discovered',
      domain: 'acmecards.test',
      category: 'other',
      alertsEnabled: true,
      hosts: [
        'api.acmecards.test:4010',
        'files.acmecards.test:4010',
        'sandbox.acmecards.test:4010',
      ],
    });
    expect(ps.get('kyco.test')).toMatchObject({ source: 'discovered', hosts: ['api.kyco.test'] });
    expect(ps.get('Stripe')).toMatchObject({
      source: 'catalog',
      category: 'payments',
      alertsEnabled: true,
    });
    expect(ps.get('AWS')).toMatchObject({
      source: 'catalog',
      category: 'infrastructure',
      alertsEnabled: false,
    });
    // rollups are keyed by the assigned provider
    const rows = await t.db.storage.rollups.aggregateByKey(
      { orgId: t.orgId, projectId: t.projectId },
      { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 60_000) },
    );
    const acme = rows.filter((r) => r.provider === 'acmecards.test');
    expect(acme.reduce((n, r) => n + r.total, 0)).toBe(3); // three hosts, one provider
    await t.close();
  });

  it('drops excluded, hidden and internal hosts', async () => {
    const t = await startTestApp({ db });
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const kyco = (await providersOf(t)).get('kyco.test')!;
    await db.storage.config.updateProvider(tenant, kyco.id, { hidden: true });
    t.ctx.directory.invalidate();
    const res = await t.app.inject(
      ingestRequest(
        batch([
          discovered('localhost:4010'),
          discovered('10.0.0.8'),
          discovered('169.254.169.254'),
          discovered('o1.ingest.sentry.io'),
          discovered('users-service:8080'),
          discovered('api.kyco.test'),
          discovered('other.kyco.test'), // same registrable domain as a hidden provider
          event({ provider: 'kyco.test', host: 'api.kyco.test' }), // old SDKs send names
        ]),
      ),
    );
    expect(res.json().accepted).toBe(0);
    await db.storage.config.updateProvider(tenant, kyco.id, { hidden: false });
    await t.close();
  });

  it('folds tenant subdomains and caps providers into "Other"', async () => {
    const t = await startTestApp({
      db,
      overrides: {
        directoryLimits: {
          maxProviders: 6,
          maxHostsPerProvider: 50,
          foldSubdomainsAt: 20,
          snapshotTtlMs: 30_000,
        },
      },
    });
    const tenants = Array.from({ length: 30 }, (_, i) => discovered(`t${i + 1}.saasco.test`));
    expect((await t.app.inject(ingestRequest(batch(tenants)))).json().accepted).toBe(30);
    const saas = (await providersOf(t)).get('saasco.test')!;
    expect(saas.hostPatterns).toContain('*.saasco.test');
    expect(saas.hosts.length).toBeLessThan(20);

    // 5 providers exist (acmecards, kyco, Stripe, AWS, saasco): one more fits, the rest go to Other
    const res = await t.app.inject(
      ingestRequest(
        batch([
          discovered('api.one.test'),
          discovered('api.two.test'),
          discovered('api.three.test'),
        ]),
      ),
    );
    expect(res.json().accepted).toBe(3);
    const ps = await providersOf(t);
    expect(ps.has('one.test')).toBe(true);
    expect(ps.has('two.test')).toBe(false);
    expect(ps.get(OTHER_PROVIDER)!.hosts.sort()).toEqual(['api.three.test', 'api.two.test']);
    await t.close();
  });

  it('serves the SDK config with hidden/internal hosts and routes, ETag and auth', async () => {
    const t = await startTestApp({ db });
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const ps = await providersOf(t);
    await db.storage.config.updateProvider(tenant, ps.get('kyco.test')!.id, { hidden: true });
    await db.storage.config.updateProvider(tenant, ps.get('one.test')!.id, { internal: true });
    await db.storage.config.updateProvider(tenant, ps.get('acmecards.test')!.id, {
      explicitRoutes: ['/v2/cards/:cardId/activate'],
    });
    expect((await t.app.inject({ method: 'GET', url: '/v1/sdk-config' })).statusCode).toBe(401);
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/sdk-config',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const cfg = res.json();
    expect(cfg.hidden).toEqual(['api.kyco.test']);
    // the folded tenant pattern from the earlier test: the SDK learns those routes together
    expect(cfg.tenants).toEqual(['*.saasco.test']);
    expect(cfg.internal).toEqual(['api.one.test']);
    expect(cfg.providers[0]).toEqual({
      name: 'acmecards.test',
      hosts: [
        'api.acmecards.test:4010',
        'files.acmecards.test:4010',
        'sandbox.acmecards.test:4010',
      ],
      routes: ['/v2/cards/:cardId/activate'],
      pathPrivacy: null,
      allowedWords: [],
    });
    // catalog route templates go to every project
    expect(cfg.providers.find((p: { name: string }) => p.name === 'Stripe')).toMatchObject({
      hosts: expect.arrayContaining(['stripe.com', '*.stripe.com']),
      routes: expect.arrayContaining(['/v1/customers/:id']),
    });
    const again = await t.app.inject({
      method: 'GET',
      url: '/v1/sdk-config',
      headers: {
        authorization: `Bearer ${TEST_API_KEY}`,
        'if-none-match': res.headers.etag as string,
      },
    });
    expect(again.statusCode).toBe(304);
    const restore: [string, Partial<ProviderInput>][] = [
      ['kyco.test', { hidden: false }],
      ['one.test', { internal: false }],
      ['acmecards.test', { explicitRoutes: [] }],
    ];
    for (const [name, patch] of restore)
      await db.storage.config.updateProvider(tenant, ps.get(name)!.id, patch);
    await t.close();
  });
});

describe('SDK with no providers → collector', () => {
  let t: TestApp;
  let provider: http.Server;
  let providerPort: number;
  let collectorUrl: string;
  beforeAll(async () => {
    t = await startTestApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    collectorUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    provider = http.createServer((req, res) => {
      req.resume();
      res.end('{}');
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
    providerPort = (provider.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await shutdown(500);
    provider.close();
    await t.close();
  });

  const call = (hostname: string, path: string) =>
    new Promise<void>((resolve, reject) => {
      const lookup = ((_h: string, o: unknown, cb: unknown) => {
        const done = (typeof o === 'function' ? o : cb) as (...a: unknown[]) => void;
        // async like dns.lookup (a sync answer can emit connect errors before http listens)
        setImmediate(() => {
          if (typeof o === 'object' && o && (o as { all?: boolean }).all)
            done(null, [{ address: '127.0.0.1', family: 4 }]);
          else done(null, '127.0.0.1', 4);
        });
      }) as typeof dns.lookup;
      http
        .get({ hostname, port: providerPort, path, lookup }, (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });

  it('creates grouped providers, then stops sending a host hidden in the dashboard', async () => {
    init(
      {
        apiKey: TEST_API_KEY,
        endpoint: collectorUrl,
        service: 'zero-config',
        flushIntervalMs: 60_000,
        handleProcessExit: false,
      },
      { remoteConfigIntervalMs: 200 },
    );
    await call('api.acmecards.test', '/v2/cards/12345');
    await call('files.acmecards.test', '/v1/files/abc123def456');
    await call('api.kyco.test', '/v1/checks');
    await flush();
    const ps = await providersOf(t);
    expect([...ps.keys()].sort()).toEqual(['acmecards.test', 'kyco.test']);
    expect(
      ps
        .get('acmecards.test')!
        .hosts.map((h) => h.split(':')[0])
        .sort(),
    ).toEqual(['api.acmecards.test', 'files.acmecards.test']);

    await t.db.storage.config.updateProvider(
      { orgId: t.orgId, projectId: t.projectId },
      ps.get('kyco.test')!.id,
      {
        hidden: true,
      },
    );
    // the SDK picks it up on its next poll (60 s in production, 200 ms here)
    await new Promise((r) => setTimeout(r, 800));
    const sentBefore = getStats()!.sent;
    for (let i = 0; i < 5; i++) await call('api.kyco.test', '/v1/checks');
    await call('api.acmecards.test', '/v2/cards/1');
    await flush();
    expect(getStats()!.sent - sentBefore).toBe(1); // only the acme call left the app
  });
});

describe('incidents on discovered providers', () => {
  const MIN = 60_000;
  const START = Date.UTC(2026, 10, 3, 10, 0);

  async function run(host: string) {
    const t = await startTestApp({ clock: new FakeClock(START) });
    const got: string[] = [];
    const hook = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push(b);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    await t.db.storage.config.createAlertChannel(tenant, {
      kind: 'webhook',
      name: 'hook',
      config: {
        url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/h`,
        secret: '0123456789abcdef',
      },
      enabled: true,
    });
    const scheduler = new Scheduler(
      t.db.storage,
      t.clock,
      [
        partitionJob(t.db.storage, { ahead: 3, rawRetentionDays: 30 }),
        incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: undefined }),
        alertJob(t.ctx.alerts),
      ],
      { info() {}, error() {} },
    );
    for (let m = 0; m < 26; m++) {
      const base = START + m * MIN;
      const events = Array.from({ length: 40 }, (_, i) =>
        discovered(host, {
          ts: base + i * 1000,
          endpoint: '/v1/items/:id',
          ...(m >= 20 && i % 5 < 2
            ? { status: 503, outcome: 'http_5xx' as const, providerRequestId: `req_${m}_${i}` }
            : { status: 200, outcome: 'ok' as const }),
        }),
      );
      t.clock.set(base + 50_000);
      expect((await t.app.inject(ingestRequest(batch(events)))).statusCode).toBe(202);
      t.clock.set(base + MIN + 5000);
      await scheduler.tick();
    }
    const incidents = await t.db.storage.incidents.list(tenant, {});
    hook.close();
    await t.close();
    return {
      incidents,
      alerts: got.map((b) => JSON.parse(b) as { event: string; provider: string }),
    };
  }

  it('opens an incident and alerts for a discovered provider', async () => {
    const { incidents, alerts } = await run('api.acmecards.test');
    expect(incidents[0]).toMatchObject({
      provider: 'acmecards.test',
      status: 'open',
      alertsMuted: false,
    });
    expect(alerts.map((a) => [a.event, a.provider])).toEqual([['open', 'acmecards.test']]);
  }, 120_000);

  it('an infrastructure provider records the incident but never alerts by default', async () => {
    const { incidents, alerts } = await run('my-bucket.s3.eu-west-1.amazonaws.com');
    expect(incidents[0]).toMatchObject({ provider: 'AWS', status: 'open', alertsMuted: true });
    expect(alerts).toEqual([]);
  }, 120_000);
});

describe('buildSdkConfig with catalog routes', () => {
  const entry = (name: string, routes?: string[]) => ({
    name,
    category: 'payments' as const,
    domains: [`${name.toLowerCase()}.test`],
    supportEmail: null,
    supportUrl: null,
    ...(routes ? { routes } : {}),
  });
  const record = (name: string, extra: Record<string, unknown> = {}) =>
    ({
      name,
      hosts: [`api.${name.toLowerCase()}.test`],
      hostPatterns: [],
      explicitRoutes: [],
      hidden: false,
      internal: false,
      pathPrivacy: null,
      allowedPathWords: [],
      ...extra,
    }) as unknown as Parameters<typeof buildSdkConfig>[0][number];

  it('sends catalog routes, merges them after the project routes, skips hidden/internal', () => {
    const cfg = buildSdkConfig(
      [
        record('Payco', { explicitRoutes: ['/v1/a/:aId'] }),
        record('Hidco', { hidden: true }),
        record('Intco', { internal: true }),
      ],
      [
        entry('Payco', ['/v1/a/:id', '/v1/b/:id']),
        entry('Hidco', ['/x/:id']),
        entry('Intco', ['/y/:id']),
        entry('Plainco'),
        entry('Newco', ['/v2/z/:id']),
      ],
    );
    expect(cfg.providers).toEqual([
      {
        name: 'Payco',
        hosts: ['api.payco.test', 'payco.test', '*.payco.test'],
        routes: ['/v1/a/:aId', '/v1/a/:id', '/v1/b/:id'],
        pathPrivacy: null,
        allowedWords: [],
      },
      {
        name: 'Newco',
        hosts: ['newco.test', '*.newco.test'],
        routes: ['/v2/z/:id'],
        pathPrivacy: null,
        allowedWords: [],
      },
    ]);
  });

  it('sends multi-host providers for grouping, within a byte budget', () => {
    const cfg = buildSdkConfig([
      record('Solo'),
      record('Multi', { hosts: ['api.multi.test', 'files.multi.test'] }),
      record('Saasco', { hosts: [], hostPatterns: ['*.saasco.test'], domain: 'saasco.test' }),
      record('Twin', { hosts: ['api.twin.test'], hostPatterns: ['*.eu.twin.test'] }),
    ]);
    expect(cfg.providers.map((p) => [p.name, p.hosts])).toEqual([
      ['Multi', ['api.multi.test', 'files.multi.test']],
      ['Twin', ['api.twin.test', '*.eu.twin.test']],
    ]);
    // thousands of big providers: the body stays well under the SDK's 512 KiB limit
    const many = Array.from({ length: 1000 }, (_, i) =>
      record(`p${i}`, { hosts: Array.from({ length: 50 }, (_, j) => `h${j}.p${i}.example.test`) }),
    );
    const body = JSON.stringify(buildSdkConfig(many));
    expect(body.length).toBeLessThan(300 * 1024);
    expect(JSON.parse(body).providers.length).toBeGreaterThan(100);
  });

  it('sends path privacy and allowed words: the dashboard’s, then the catalog’s', () => {
    const cfg = buildSdkConfig(
      [
        record('Shopco', { pathPrivacy: 'balanced', allowedPathWords: ['jackets'] }),
        record('Hidco', { hidden: true, allowedPathWords: ['x'] }),
      ],
      [
        { ...entry('Shopco'), allowedWords: ['jackets', 'sneakers'] },
        { ...entry('Wordco'), allowedWords: ['ledgerline'] },
      ],
    );
    expect(cfg.providers).toEqual([
      {
        name: 'Shopco',
        hosts: ['api.shopco.test', 'shopco.test', '*.shopco.test'],
        routes: [],
        pathPrivacy: 'balanced',
        allowedWords: ['jackets', 'sneakers'],
      },
      {
        name: 'Wordco',
        hosts: ['wordco.test', '*.wordco.test'],
        routes: [],
        pathPrivacy: null,
        allowedWords: ['ledgerline'],
      },
    ]);
  });

  it('sends the folded *.domain patterns as tenants, not hand-made or hidden ones', () => {
    const cfg = buildSdkConfig([
      record('Saasco', { domain: 'saasco.test', hostPatterns: ['*.saasco.test'] }),
      record('Handco', { domain: 'handco.test', hostPatterns: ['*.eu.handco.test'] }),
      record('Hidco', { domain: 'hidco.test', hostPatterns: ['*.hidco.test'], hidden: true }),
    ]);
    expect(cfg.tenants).toEqual(['*.saasco.test']);
  });
});
