import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Catalog, type CallEvent } from '@theirside/shared';
import { suggestProvider } from '../src/modules/discovery/candidate-match.js';
import { runDigest, webhookRoutesPayload } from '../src/modules/discovery/jobs.js';
import { renderEmail, renderSlack } from '../src/modules/alerts/render.js';
import type { ProviderRecord, WebhookCandidate } from '../src/storage/types.js';
import {
  THEIRSIDE_ADMIN_TOKEN,
  batch,
  event,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

/**
 * Confirming a discovered webhook route: link it to the provider the team already
 * monitors (one provider for outgoing calls and webhooks) or create a new one; the
 * best match is suggested with a reason. Confirmed routes are listed with the
 * monitored ones right away; new routes are announced once to alert channels.
 */

const provider = (p: Partial<ProviderRecord> & { name: string }): ProviderRecord =>
  ({
    id: `prv_${p.name}`,
    orgId: 'o',
    projectId: 'p',
    hostPatterns: [],
    explicitRoutes: [],
    supportEmail: null,
    supportUrl: null,
    supportNotes: null,
    publicDisplayName: null,
    isPublic: false,
    source: 'discovered',
    category: 'other',
    hosts: [],
    domain: null,
    hidden: false,
    internal: false,
    alertsEnabled: true,
    displayName: null,
    ...p,
  }) as ProviderRecord;

describe('suggestProvider', () => {
  const catalog = new Catalog(
    [
      {
        name: 'PayCo',
        category: 'payments',
        domains: ['payco.test'],
        supportEmail: null,
        supportUrl: null,
      },
    ],
    [],
  );
  const providers = [
    provider({
      name: 'examplepay.test',
      domain: 'examplepay.test',
      hosts: ['api.examplepay.test'],
      displayName: 'Example Pay',
    }),
    provider({ name: 'Ledgerly', source: 'configured', hostPatterns: ['*.ledgerly.co.uk'] }),
    provider({ name: 'NotifyCo', source: 'configured' }),
    provider({ name: 'hidden.test', domain: 'hidden.test', hidden: true }),
  ];
  it.each([
    // [suggested name, kind, provider, reason]
    ['examplepay', 'existing', 'examplepay.test', 'same domain as examplepay.test'],
    ['ledgerly', 'existing', 'Ledgerly', 'same domain as ledgerly.co.uk'],
    ['payco', 'catalog', 'PayCo', 'known provider (payco.test)'],
    ['notifyco', 'existing', 'NotifyCo', 'same name'],
    ['lemon-squeezy', 'new', 'Lemon Squeezy', 'name suggested by the SDK'],
    // a hidden provider is never suggested
    ['hidden', 'new', 'Hidden', 'name suggested by the SDK'],
  ] as const)('%s → %s %s (%s)', (name, kind, p, reason) => {
    expect(suggestProvider(name, providers, catalog)).toMatchObject({ kind, provider: p, reason });
  });

  it('a catalog provider already monitored is linked, not created again', () => {
    const withPayCo = [...providers, provider({ name: 'PayCo', source: 'catalog' })];
    expect(suggestProvider('payco', withPayCo, catalog)).toMatchObject({
      kind: 'existing',
      provider: 'PayCo',
      reason: 'known provider PayCo (payco.test)',
    });
  });

  it('no suggestion without a suggested name', () => {
    expect(suggestProvider(null, providers, catalog)).toBeNull();
  });
});

describe('confirming a discovered webhook route', () => {
  let t: TestApp;
  const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });
  const admin = (method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
      ...(payload ? { payload } : {}),
    });
  const candidate = (
    endpoint: string,
    name: string | null,
    o: Partial<CallEvent> = {},
  ): CallEvent => ({
    ts: Date.now(),
    provider: name ?? 'unknown',
    host: 'inbound',
    method: 'POST',
    endpoint,
    status: 200,
    durationMs: 10,
    outcome: 'ok',
    direction: 'inbound',
    candidate: true,
    count: 3,
    ...o,
  });
  const ingest = async (events: CallEvent[]) => {
    const res = await t.app.inject(ingestRequest(batch(events, { service: 'billing-api' })));
    expect(res.statusCode).toBe(202);
  };
  type Row = { endpoint: string; status: string; provider: string | null; match: unknown };
  const candidates = async () =>
    (await admin('GET', '/v1/admin/webhooks/candidates')).json().candidates as Row[];
  const providerNames = async () =>
    (await t.db.storage.config.listProviders(tenant())).map((p) => p.name).sort();

  beforeAll(async () => {
    t = await startTestApp();
    // an outgoing provider found by auto-discovery
    await ingest([event({ provider: null, host: 'api.examplepay.test', endpoint: '/v1/charges' })]);
  });
  afterAll(async () => t.close());

  it('suggests the outgoing provider with the same domain, and why', async () => {
    await ingest([candidate('/v1/examplepay', 'examplepay')]);
    const c = (await candidates()).find((x) => x.endpoint === '/v1/examplepay')!;
    expect(c.match).toEqual({
      kind: 'existing',
      provider: 'examplepay.test',
      label: 'examplepay.test',
      reason: 'same domain as examplepay.test',
    });
  });

  it('confirm and link: no second provider; listed as monitored at once, then like any source', async () => {
    const before = await providerNames();
    const res = await admin('PUT', '/v1/admin/webhooks/candidates/confirm', {
      endpoint: '/v1/examplepay',
      provider: 'examplepay.test',
      mode: 'link',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      provider: 'examplepay.test',
      linked: true,
    });
    expect(await providerNames()).toEqual(before);
    // the SDK records it under that provider from now on
    const cfg = await t.app.inject({
      method: 'GET',
      url: '/v1/sdk-config',
      headers: { authorization: ingestRequest({}).headers.authorization },
    });
    expect(cfg.json().webhookRoutes).toContainEqual({
      path: '/v1/examplepay',
      provider: 'examplepay.test',
    });
    // the Webhooks page lists it before the first delivery
    const list = async () =>
      (await admin('GET', '/v1/admin/webhooks?range=24h')).json().providers as {
        provider: string;
        sources: { endpoint: string; status: string; lastDeliveryAt: string | null }[];
      }[];
    expect((await list()).find((p) => p.provider === 'examplepay.test')?.sources).toEqual([
      expect.objectContaining({
        endpoint: '/v1/examplepay',
        status: 'waiting',
        lastDeliveryAt: null,
      }),
    ]);
    // and the provider page (provider filter) too
    const one = (
      await admin('GET', '/v1/admin/webhooks?range=24h&provider=examplepay.test')
    ).json();
    expect(one.providers[0].sources[0]).toMatchObject({
      endpoint: '/v1/examplepay',
      status: 'waiting',
    });
    // the first delivery: an ordinary source, no waiting row left
    await ingest([
      {
        ...candidate('/v1/examplepay', 'examplepay.test'),
        candidate: undefined,
        count: undefined,
        environment: 'production',
      } as CallEvent,
    ]);
    const after = (await list()).find((p) => p.provider === 'examplepay.test')!.sources;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ endpoint: '/v1/examplepay' });
    expect(after[0]!.status).not.toBe('waiting');
    expect(after[0]!.lastDeliveryAt).not.toBeNull();
  });

  it('confirm as new: a provider is created; refused when one with that name exists', async () => {
    await ingest([candidate('/v1/inbox', 'relayly'), candidate('/hooks/:id', null)]);
    const created = await admin('PUT', '/v1/admin/webhooks/candidates/confirm', {
      endpoint: '/v1/inbox',
      provider: 'Relayly',
      mode: 'new',
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ provider: 'Relayly', linked: false });
    expect(await providerNames()).toContain('Relayly');
    // another route: "new" with the same name in another spelling is refused, with the existing one
    const dup = await admin('PUT', '/v1/admin/webhooks/candidates/confirm', {
      endpoint: '/hooks/:id',
      provider: 'relayly',
      mode: 'new',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ provider: 'Relayly' });
    // linking needs an existing provider
    const missing = await admin('PUT', '/v1/admin/webhooks/candidates/confirm', {
      endpoint: '/hooks/:id',
      provider: 'Nobody Inc',
      mode: 'link',
    });
    expect(missing.statusCode).toBe(404);
    expect((await candidates()).find((x) => x.endpoint === '/hooks/:id')!.status).toBe('pending');
  });

  it('a catalog provider created on confirm gets the catalog category', async () => {
    await ingest([candidate('/webhooks/stripe-connect', 'stripe')]);
    const c = (await candidates()).find((x) => x.endpoint === '/webhooks/stripe-connect')!;
    expect(c.match).toMatchObject({ kind: 'catalog', provider: 'Stripe' });
    const res = await admin('PUT', '/v1/admin/webhooks/candidates/confirm', {
      endpoint: '/webhooks/stripe-connect',
      provider: 'Stripe',
      mode: 'new',
    });
    expect(res.statusCode).toBe(200);
    const p = (await t.db.storage.config.listProviders(tenant())).find((x) => x.name === 'Stripe')!;
    expect(p.category).toBe('payments');
  });

  it('the Providers page lists routes discovered in the last 24 h', async () => {
    await ingest([candidate('/v1/telemetry', 'telemetry')]);
    const o = (await admin('GET', '/v1/admin/overview')).json();
    expect(o.discovery.webhookRoutes).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        endpoint: '/v1/telemetry',
        suggestedName: 'telemetry',
      }),
    );
    // decided routes are not "new"
    expect(o.discovery.webhookRoutes.map((r: { endpoint: string }) => r.endpoint)).not.toContain(
      '/v1/examplepay',
    );
  });
});

describe('"new webhook route discovered" notice', () => {
  let t: TestApp;
  const got: { event: string; title: string; url: string | null; webhookRoutes?: unknown[] }[] = [];
  let hook: http.Server;
  const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });
  const admin = (method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
      ...(payload ? { payload } : {}),
    });
  const report = (endpoint: string, name: string) =>
    t.app.inject(
      ingestRequest(
        batch([
          {
            ts: Date.now(),
            provider: name,
            host: 'inbound',
            method: 'POST',
            endpoint,
            status: 200,
            durationMs: 5,
            outcome: 'ok',
            direction: 'inbound',
            candidate: true,
            count: 1,
          },
        ]),
      ),
    );
  const digest = async () => {
    const n = await runDigest(t.db.storage, t.ctx.alerts, tenant(), 'https://theirside.internal');
    await t.ctx.alerts.sendDue();
    return n;
  };

  beforeAll(async () => {
    t = await startTestApp();
    hook = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push(JSON.parse(b));
        res.end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    await t.db.storage.config.createAlertChannel(tenant(), {
      kind: 'webhook',
      name: 'hook',
      config: {
        url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`,
        secret: '0123456789abcdef',
      },
      enabled: true,
    });
  });
  afterAll(async () => {
    hook.close();
    await t.close();
  });

  it('once per route, linking to the Webhooks page; can be switched off without a backlog', async () => {
    await report('/v1/example', 'example');
    expect(await digest()).toBe(1);
    expect(got.at(-1)).toMatchObject({
      event: 'discovery',
      title: 'New webhook route discovered: POST /v1/example (suggested: example)',
      url: 'https://theirside.internal/#/webhooks',
      webhookRoutes: [{ method: 'POST', endpoint: '/v1/example', suggestedName: 'example' }],
    });
    // once: the same route again, nothing
    await report('/v1/example', 'example');
    expect(await digest()).toBe(0);

    expect(
      (await admin('PUT', '/v1/admin/settings/discovery', { webhookRoutes: false })).json(),
    ).toEqual({
      digest: true,
      webhookRoutes: false,
    });
    await report('/v1/other', 'other');
    const sent = got.length;
    expect(await digest()).toBe(0);
    expect(got).toHaveLength(sent);
    // back on: the route found while it was off isn't announced late
    await admin('PUT', '/v1/admin/settings/discovery', { webhookRoutes: true });
    expect(await digest()).toBe(0);
  });

  it('renders for Slack and email', () => {
    const c: WebhookCandidate = {
      endpoint: '/v1/example',
      method: 'POST',
      suggestedName: 'example',
      status: 'pending',
      provider: null,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      lastService: 'billing-api',
      decidedAt: null,
      decidedBy: null,
      deliveries7d: 3,
      activeDays: 1,
    };
    const p = webhookRoutesPayload([c], 'https://theirside.internal');
    const slack = JSON.stringify(renderSlack(p));
    expect(slack).toContain('New webhook route discovered');
    expect(slack).toContain('`POST /v1/example` (suggested: example) · received by billing-api');
    expect(slack).toContain('Review webhook routes');
    const email = renderEmail(p);
    expect(email.subject).toContain(
      'New webhook route discovered: POST /v1/example (suggested: example)',
    );
    expect(email.text).toContain('Review webhook routes: https://theirside.internal/#/webhooks');
    expect(email.html).toContain('New webhook route discovered');
  });
});
