import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/modules/auth/api-keys.js';
import { alertJob, incidentJob } from '../src/modules/incidents/job.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
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

const MIN = 60_000;
const START = Date.UTC(2026, 10, 3, 9, 0);
let t: TestApp;
let statusToken: string;

async function minute(m: number, opts: { failCards?: boolean; kycCalls?: number } = {}) {
  const base = START + m * MIN;
  const events = [];
  for (let i = 0; i < 30; i++) {
    const fail = opts.failCards && i % 2 === 0;
    events.push(
      event({
        ts: base + i * 1000,
        provider: 'Acme Cards',
        host: 'api.acmecards.test',
        endpoint: '/v2/cards/:id/activate',
        ...(fail
          ? { status: 503, outcome: 'http_5xx' as const, providerRequestId: `req_${m}_${i}` }
          : { status: 200, outcome: 'ok' as const }),
      }),
    );
  }
  for (let i = 0; i < (opts.kycCalls ?? 20); i++) {
    events.push(
      event({
        ts: base + i * 1000,
        provider: 'KYCo',
        host: 'kyc.test',
        method: 'POST',
        endpoint: '/v1/kyc/checks',
        durationMs: 300,
      }),
    );
  }
  t.clock.set(base + 50_000);
  expect((await t.app.inject(ingestRequest(batch(events)))).statusCode).toBe(202);
  t.clock.set(base + MIN + 5000);
}

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(START) });
  const tenant = { orgId: t.orgId, projectId: t.projectId };
  const scheduler = new Scheduler(
    t.db.storage,
    t.clock,
    [
      incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: 'http://c.test' }),
      alertJob(t.ctx.alerts),
    ],
    { info() {}, error() {} },
  );
  for (let m = 0; m < 20; m++) {
    await minute(m, { failCards: m >= 14 });
    await scheduler.tick();
  }
  const providers = await t.db.storage.config.listProviders(tenant);
  const acme = providers.find((p) => p.name === 'Acme Cards')!;
  await t.db.storage.config.updateProvider(tenant, acme.id, {
    isPublic: true,
    publicDisplayName: 'Card issuing',
  });
  statusToken = (await t.db.storage.config.listStatusPages(tenant))[0]!.publicToken;
}, 60_000);
afterAll(async () => {
  await t.close();
});

const admin = (url: string, init: { method?: 'GET' | 'PATCH' | 'PUT'; payload?: unknown } = {}) =>
  t.app.inject({
    method: init.method ?? 'GET',
    url,
    headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    ...(init.payload ? { payload: init.payload } : {}),
  });

describe('GET /v1/health', () => {
  it('needs a key with the read scope', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(401);
    const { key } = await createApiKey(
      t.db.storage.config,
      { orgId: t.orgId, projectId: t.projectId },
      'ingest only',
      ['ingest'],
    );
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/v1/health',
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('returns providers with status, score and endpoint breakdown', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const h = res.json();
    expect(h.windowMinutes).toBe(5);
    const acme = h.providers.find((p: { name: string }) => p.name === 'Acme Cards');
    const kyc = h.providers.find((p: { name: string }) => p.name === 'KYCo');
    expect(acme).toMatchObject({ status: 'red', openIncidentId: expect.stringMatching(/^inc_/) });
    expect(acme.score).toBeLessThan(60);
    expect(acme.endpoints[0]).toMatchObject({
      method: 'POST',
      endpoint: '/v2/cards/:id/activate',
      inIncident: true,
      status: 'red',
    });
    expect(acme.endpoints[0].errorRate).toBeCloseTo(0.5, 1);
    expect(kyc).toMatchObject({ status: 'green', score: 100, callsPerMin: 20 });
    // red providers first
    expect(h.providers[0].name).toBe('Acme Cards');
  });

  it('filters by environment', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/health?environment=staging',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(
      res.json().providers.every((p: { endpoints: unknown[] }) => p.endpoints.length === 0),
    ).toBe(true);
  });
});

describe('GET /v1/incidents', () => {
  it('lists open incidents with the summary', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/incidents?status=open',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    const { incidents } = res.json();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      provider: 'Acme Cards',
      status: 'open',
      scope: 'endpoint',
      kind: 'errors',
    });
    expect(incidents[0].summary).toMatch(
      /^Acme Cards — POST \/v2\/cards\/:id\/activate failing since/,
    );
    expect(incidents[0].sampleRequestIds.length).toBeGreaterThan(0);
  });

  it('validates the query', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/incidents?status=bogus',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('serves the OpenAPI document', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/openapi.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/v1/health:');
    expect(res.body).toContain('/v1/incidents:');
  });
});

describe('dashboard API', () => {
  it('overview includes open incidents and environments', async () => {
    const o = (await admin('/v1/admin/overview')).json();
    expect(o.openIncidents).toHaveLength(1);
    expect(o.environments).toEqual(['production']);
  });

  it.each(['1h', '24h', '7d'])('series for %s with baseline band', async (range) => {
    const res = await admin(
      `/v1/admin/series?provider=Acme%20Cards&endpoint=${encodeURIComponent('/v2/cards/:id/activate')}&method=POST&range=${range}`,
    );
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.points.length).toBe(range === '1h' ? 60 : range === '24h' ? 96 : 84);
    const nonEmpty = s.points.filter((p: { calls: number }) => p.calls > 0);
    expect(nonEmpty.length).toBeGreaterThan(0);
    expect(s.baseline).toMatchObject({ learning: true });
    expect(s.baseline.errorThreshold).toBeGreaterThan(s.baseline.errorRate);
    if (range === '1h') {
      const last = nonEmpty.at(-1);
      expect(last.outcomeRates.http_5xx).toBeCloseTo(0.5, 1);
      expect(last.callsPerMin).toBe(30);
    }
  });

  it('updates provider settings used by the status page', async () => {
    const { providers } = (await admin('/v1/admin/providers')).json();
    const kyc = providers.find((p: { name: string }) => p.name === 'KYCo');
    const res = await admin(`/v1/admin/providers/${kyc.id}`, {
      method: 'PATCH',
      payload: {
        supportEmail: 'help@kyco.test',
        publicDisplayName: 'Identity checks',
        isPublic: false,
      },
    });
    expect(res.json()).toMatchObject({
      supportEmail: 'help@kyco.test',
      publicDisplayName: 'Identity checks',
      isPublic: false,
    });
    expect(
      (
        await admin(`/v1/admin/providers/${kyc.id}`, {
          method: 'PATCH',
          payload: { isPublic: 'yes' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('lists SDK instances and status pages', async () => {
    const sdk = (await admin('/v1/admin/sdk-instances')).json();
    expect(sdk.instances[0]).toMatchObject({
      service: 'payments-api',
      environment: 'production',
      stale: false,
    });
    const pages = (await admin('/v1/admin/status-pages')).json();
    expect(pages.statusPages[0].embedSnippet).toContain(`data-token="${statusToken}"`);
  });

  it('stores per-project threshold overrides', async () => {
    expect(
      (
        await admin('/v1/admin/settings/thresholds', {
          method: 'PUT',
          payload: { thresholds: { minCalls: 50 } },
        })
      ).statusCode,
    ).toBe(200);
    const got = (await admin('/v1/admin/settings/thresholds')).json();
    expect(got.thresholds).toEqual({ minCalls: 50 });
    // the values in force: the override over the defaults
    expect(got.effective).toMatchObject({ minCalls: 50, openAfterMinutes: 3, windowMinutes: 5 });
    // the built-in values, for "reset to default"
    expect(got.defaults).toMatchObject({ minCalls: 20, openAfterMinutes: 3 });
    await admin('/v1/admin/settings/thresholds', { method: 'PUT', payload: { thresholds: {} } });
  });
});

describe('status page', () => {
  it('shows only public providers by display name, without paths or volumes', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/status/${statusToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const html = res.body;
    expect(html).toContain('Card issuing');
    expect(html).toContain('Outage');
    expect(html).not.toContain('Acme Cards');
    expect(html).not.toContain('KYCo');
    expect(html).not.toContain('Identity checks');
    expect(html).not.toContain('/v2/cards');
    expect(html).not.toMatch(/calls/i);
    expect((html.match(/class="bar /g) ?? []).length).toBe(30);
  });

  it('caches for 30 seconds', async () => {
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const acme = (await t.db.storage.config.listProviders(tenant)).find(
      (p) => p.name === 'Acme Cards',
    )!;
    await t.db.storage.config.updateProvider(tenant, acme.id, {
      publicDisplayName: 'Cards (renamed)',
    });
    expect((await t.app.inject({ method: 'GET', url: `/status/${statusToken}` })).body).toContain(
      'Card issuing',
    );
    t.clock.advance(31_000);
    expect((await t.app.inject({ method: 'GET', url: `/status/${statusToken}` })).body).toContain(
      'Cards (renamed)',
    );
  });

  it('supports theme, providers filter and embed mode', async () => {
    const dark = await t.app.inject({
      method: 'GET',
      url: `/status/${statusToken}?theme=dark&embed=1`,
    });
    expect(dark.body).toContain('--color-background:#09090B');
    expect(dark.body).not.toContain('--color-background:#FFFFFF');
    expect(dark.body).not.toContain('prefers-color-scheme');
    expect(dark.body).toContain('theirside-status-height');
    expect(dark.body).not.toContain('<h1>');
    const filtered = await t.app.inject({
      method: 'GET',
      url: `/status/${statusToken}?providers=Nope`,
    });
    expect(filtered.body).toContain('No integrations are published');
  });

  it('404s for unknown tokens and escapes HTML', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/status/doesnotexist000' })).statusCode).toBe(
      404,
    );
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const acme = (await t.db.storage.config.listProviders(tenant)).find(
      (p) => p.name === 'Acme Cards',
    )!;
    await t.db.storage.config.updateProvider(tenant, acme.id, {
      publicDisplayName: '<script>alert(1)</script>',
    });
    t.clock.advance(31_000);
    const html = (await t.app.inject({ method: 'GET', url: `/status/${statusToken}` })).body;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('uses the design tokens and the self-hosted fonts, with the spacing rules', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/status/${statusToken}` });
    const html = res.body;
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain("font-family:'Albert Sans'");
    expect(html).toContain('url(../fonts/albert-sans-latin-wght-normal.woff2)');
    expect(res.headers['content-security-policy']).toContain("font-src 'self'");
    // title → status box 24px, status box → first divider 32px, 24px around each divider
    expect(html).toContain(
      'h1{font-size:var(--text-xl);line-height:var(--leading-xl);font-weight:var(--weight-bold);margin:0 0 var(--space-6)}',
    );
    expect(html).toMatch(/\.overall\{[^}]*margin-bottom:var\(--space-8\)/);
    expect(html).toMatch(
      /\.provider\{padding:var\(--space-6\) 0;border-top:1px solid var\(--color-border\)\}/,
    );
    const font = await t.app.inject({
      method: 'GET',
      url: '/fonts/albert-sans-latin-wght-normal.woff2',
    });
    expect(font.statusCode).toBe(200);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(font.rawPayload.subarray(0, 4).toString('latin1')).toBe('wOF2');
    for (const url of [
      '/fonts/nope.woff2',
      '/fonts/..%2Fpackage.json',
      '/fonts/OFL-albert-sans.txt',
    ])
      expect((await t.app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
  });

  it('serves embed.js', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/embed.js' });
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain("'/status/'");
    expect(res.body).toContain('data-token');
    expect(res.body).toContain('theirside-status-height');
  });
});

describe('dashboard', () => {
  it('serves the SPA at / (or explains how to build it)', async () => {
    const { existsSync } = await import('node:fs');
    const { DEFAULT_STATIC_DIR } = await import('../src/modules/dashboard/static.js');
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    if (existsSync(`${DEFAULT_STATIC_DIR}/index.html`)) {
      expect(res.body).toContain('<div id="root">');
      expect(res.headers['cache-control']).toBe('no-cache');
    } else {
      expect(res.body).toContain('Dashboard not built');
    }
  });
});
