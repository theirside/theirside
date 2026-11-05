import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderEmail, renderSlack } from '../src/modules/alerts/render.js';
import {
  digestPayload,
  findMergedRoutes,
  mergeTemplates,
  runDigest,
} from '../src/modules/discovery/jobs.js';
import { FakeClock } from '../src/util/clock.js';
import {
  batch,
  event,
  ingestRequest,
  startTestApp,
  THEIRSIDE_ADMIN_TOKEN,
  TEST_API_KEY,
  type TestApp,
} from './helpers.js';

const NOW = new Date('2026-11-04T12:00:30Z');
const discovered = (host: string, extra: Parameters<typeof event>[0] = {}) =>
  event({ provider: null, host, ts: NOW.getTime() - 60_000, ...extra });

let t: TestApp;
const admin = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    ...(payload ? { payload } : {}),
  });
const provider = async (name: string) =>
  (
    (await admin('GET', '/v1/admin/providers')).json().providers as { id: string; name: string }[]
  ).find((p) => p.name === name)!;

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(NOW) });
  const res = await t.app.inject(
    ingestRequest(
      batch([
        discovered('api.acmecards.test', { endpoint: '/v2/cards/:id' }),
        discovered('files.acmecards.test', { endpoint: '/v1/files/:id' }),
        discovered('api.acme-cards-eu.test', { endpoint: '/v2/cards/:id' }),
        discovered('api.kyco.test'),
        discovered('api.stripe.com', { endpoint: '/v1/charges' }),
      ]),
    ),
  );
  expect(res.json().accepted).toBe(5);
});
afterAll(async () => {
  await t.close();
});

describe('provider actions', () => {
  it('overview lists discovered providers with label, source, category and the "Discovered" notice', async () => {
    const o = (await admin('GET', '/v1/admin/overview')).json();
    const stripe = o.providers.find((p: { name: string }) => p.name === 'Stripe');
    expect(stripe).toMatchObject({
      label: 'Stripe',
      source: 'catalog',
      category: 'payments',
      alertsEnabled: true,
    });
    expect(o.discovery.recent.map((p: { name: string }) => p.name).sort()).toEqual([
      'Stripe',
      'acme-cards-eu.test',
      'acmecards.test',
      'kyco.test',
    ]);
    expect(o.discovery.overflow).toBe(false);
  });

  it('rename, alerts off, hide and mark internal', async () => {
    const acme = await provider('acmecards.test');
    const r = await admin('PATCH', `/v1/admin/providers/${acme.id}`, {
      displayName: 'Acme Cards',
      alertsEnabled: false,
    });
    expect(r.json()).toMatchObject({
      name: 'acmecards.test',
      displayName: 'Acme Cards',
      alertsEnabled: false,
    });
    expect(
      (await admin('GET', '/v1/admin/overview'))
        .json()
        .providers.find((p: { name: string }) => p.name === 'acmecards.test').label,
    ).toBe('Acme Cards');

    const kyco = await provider('kyco.test');
    await admin('PATCH', `/v1/admin/providers/${kyco.id}`, { hidden: true });
    // ingest drops it at once; the SDK config lists it
    expect(
      (await t.app.inject(ingestRequest(batch([discovered('api.kyco.test')])))).json().accepted,
    ).toBe(0);
    const cfg = (
      await t.app.inject({
        method: 'GET',
        url: '/v1/sdk-config',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
      })
    ).json();
    expect(cfg.hidden).toEqual(['api.kyco.test']);
    // hidden providers disappear from the overview
    expect(
      (await admin('GET', '/v1/admin/overview'))
        .json()
        .providers.some((p: { name: string }) => p.name === 'kyco.test'),
    ).toBe(false);
    await admin('PATCH', `/v1/admin/providers/${kyco.id}`, { hidden: false, internal: true });
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/v1/sdk-config',
          headers: { authorization: `Bearer ${TEST_API_KEY}` },
        })
      ).json().internal,
    ).toEqual(['api.kyco.test']);
    await admin('PATCH', `/v1/admin/providers/${kyco.id}`, { internal: false });
  });

  it('sets path privacy and allowed path words per provider, pushed to the SDK', async () => {
    const kyco = (await provider('kyco.test'))!;
    const sdkConfig = async () =>
      (
        await t.app.inject({
          method: 'GET',
          url: '/v1/sdk-config',
          headers: { authorization: `Bearer ${TEST_API_KEY}` },
        })
      ).json();
    expect(
      (await sdkConfig()).providers.some((p: { name: string }) => p.name === 'kyco.test'),
    ).toBe(false);
    const res = await admin('PATCH', `/v1/admin/providers/${kyco.id}`, {
      pathPrivacy: 'balanced',
      allowedPathWords: ['Sneakers', ' jackets ', 'sneakers'],
    });
    expect(res.json()).toMatchObject({
      pathPrivacy: 'balanced',
      allowedPathWords: ['sneakers', 'jackets'],
    });
    // sent even without routes
    expect(
      (await sdkConfig()).providers.find((p: { name: string }) => p.name === 'kyco.test'),
    ).toEqual({
      name: 'kyco.test',
      hosts: ['api.kyco.test'],
      routes: [],
      pathPrivacy: 'balanced',
      allowedWords: ['sneakers', 'jackets'],
    });
    for (const bad of [{ pathPrivacy: 'loose' }, { allowedPathWords: ['two words'] }])
      expect((await admin('PATCH', `/v1/admin/providers/${kyco.id}`, bad)).statusCode).toBe(400);
    const back = await admin('PATCH', `/v1/admin/providers/${kyco.id}`, {
      pathPrivacy: null,
      allowedPathWords: [],
    });
    expect(back.json()).toMatchObject({ pathPrivacy: null, allowedPathWords: [] });
  });

  it('merges one provider into another, history included', async () => {
    const eu = await provider('acme-cards-eu.test');
    const acme = await provider('acmecards.test');
    // a merge never loosens path privacy, and keeps both providers' allowed words
    await admin('PATCH', `/v1/admin/providers/${eu.id}`, {
      pathPrivacy: 'strict',
      allowedPathWords: ['sneakers'],
    });
    await admin('PATCH', `/v1/admin/providers/${acme.id}`, {
      pathPrivacy: 'balanced',
      allowedPathWords: ['jackets'],
    });
    const res = await admin('POST', `/v1/admin/providers/${eu.id}/merge`, { into: acme.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().pathPrivacy).toBe('strict');
    expect(res.json().allowedPathWords.sort()).toEqual(['jackets', 'sneakers']);
    expect(res.json().hosts.sort()).toEqual([
      'api.acme-cards-eu.test',
      'api.acmecards.test',
      'files.acmecards.test',
    ]);
    expect(await provider('acme-cards-eu.test')).toBeUndefined();
    const rows = await t.db.storage.rollups.aggregateByKey(
      { orgId: t.orgId, projectId: t.projectId },
      { from: new Date(NOW.getTime() - 3600_000), to: new Date(NOW.getTime() + 60_000) },
    );
    expect(rows.some((r) => r.provider === 'acme-cards-eu.test')).toBe(false);
    // the two /v2/cards/:id rows were added together
    expect(
      rows.find((r) => r.provider === 'acmecards.test' && r.endpoint === '/v2/cards/:id')!.total,
    ).toBe(2);
    // new traffic from the merged host lands on the target
    expect(
      (await t.app.inject(ingestRequest(batch([discovered('api.acme-cards-eu.test')])))).json()
        .accepted,
    ).toBe(1);
    expect(await provider('acme-cards-eu.test')).toBeUndefined();
    expect(
      (await admin('POST', `/v1/admin/providers/${acme.id}/merge`, { into: acme.id })).statusCode,
    ).toBe(400);
  });

  it('splits a host out into its own provider', async () => {
    const acme = await provider('acmecards.test');
    const res = await admin('POST', `/v1/admin/providers/${acme.id}/split`, {
      host: 'files.acmecards.test',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'files.acmecards.test',
      hosts: ['files.acmecards.test'],
    });
    expect(
      (await t.app.inject(ingestRequest(batch([discovered('files.acmecards.test')])))).json()
        .accepted,
    ).toBe(1);
    const rows = await t.db.storage.rollups.aggregateByKey(
      { orgId: t.orgId, projectId: t.projectId },
      { from: new Date(NOW.getTime() - 3600_000), to: new Date(NOW.getTime() + 60_000) },
    );
    expect(rows.some((r) => r.provider === 'files.acmecards.test')).toBe(true);
    expect(
      (await admin('POST', `/v1/admin/providers/${acme.id}/split`, { host: 'nope.test' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('discovery digest', () => {
  it('sends one message listing new providers, then nothing until more appear; can be switched off', async () => {
    const got: string[] = [];
    const hook = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push(b);
        res.end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    await t.db.storage.config.createAlertChannel(tenant, {
      kind: 'webhook',
      name: 'hook',
      config: {
        url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`,
        secret: '0123456789abcdef',
      },
      enabled: true,
    });
    expect((await admin('GET', '/v1/admin/settings/discovery')).json()).toEqual({ digest: true });
    expect(
      await runDigest(t.db.storage, t.ctx.alerts, tenant, 'https://theirside.internal'),
    ).toBeGreaterThanOrEqual(3);
    await t.ctx.alerts.sendDue();
    const msg = JSON.parse(got[0]!);
    expect(msg.event).toBe('discovery');
    expect(msg.title).toMatch(/new providers discovered: /);
    expect(msg.url).toBe('https://theirside.internal/#/settings/providers');
    expect(await runDigest(t.db.storage, t.ctx.alerts, tenant, undefined)).toBe(0);

    await admin('PUT', '/v1/admin/settings/discovery', { digest: false });
    await t.app.inject(ingestRequest(batch([discovered('api.newco.test')])));
    expect(await runDigest(t.db.storage, t.ctx.alerts, tenant, undefined)).toBe(0);
    // switching it back on doesn't send the backlog
    await admin('PUT', '/v1/admin/settings/discovery', { digest: true });
    expect(await runDigest(t.db.storage, t.ctx.alerts, tenant, undefined)).toBe(0);
    hook.close();
  });

  it('renders for Slack and email', () => {
    const p = digestPayload(
      [
        {
          name: 'Stripe',
          displayName: null,
          category: 'payments',
          hosts: ['api.stripe.com'],
          hostPatterns: [],
          alertsEnabled: true,
        },
        {
          name: 'AWS',
          displayName: null,
          category: 'infrastructure',
          hosts: [],
          hostPatterns: ['*.amazonaws.com'],
          alertsEnabled: false,
        },
      ] as never,
      'https://theirside.internal',
    );
    expect(renderSlack(p)).toMatchSnapshot();
    const m = renderEmail(p);
    expect(m.subject).toBe('[Theirside] 2 new providers discovered: Stripe, AWS');
    expect(m.text).toMatchSnapshot();
  });
});

describe('template merging', () => {
  it.each([
    [
      'letters-only names at one position',
      Array.from({ length: 12 }, (_, i) => `/v1/users/${'abcdefghijkl'[i]}name/profile`),
      [],
      ['/v1/users/:id/profile'],
    ],
    ['below the threshold', ['/v1/users/jane', '/v1/users/bob'], [], []],
    [
      'resource names under different parents',
      ['/v1/customers', '/v1/charges', '/v2/refunds'],
      [],
      [],
    ],
    [
      'already covered by a route',
      Array.from({ length: 12 }, (_, i) => `/v1/users/${'abcdefghijkl'[i]}x`),
      ['/v1/users/:userId'],
      [],
    ],
  ])('%s', (_n, endpoints, existing, expected) => {
    expect(
      findMergedRoutes(
        endpoints.map((endpoint) => ({ method: 'GET', endpoint })),
        existing,
        10,
      ),
    ).toEqual(expected);
  });

  it('adds merged routes to the provider, which the SDK config then carries', async () => {
    const people = Array.from({ length: 12 }, (_, i) =>
      discovered('api.peopleco.test', { endpoint: `/v1/people/${'abcdefghijkl'[i]}name` }),
    );
    expect((await t.app.inject(ingestRequest(batch(people)))).json().accepted).toBe(12);
    const merged = await mergeTemplates(
      t.db.storage,
      { orgId: t.orgId, projectId: t.projectId },
      NOW,
    );
    expect(merged).toEqual([{ provider: 'peopleco.test', routes: ['/v1/people/:id'] }]);
    const cfg = (
      await t.app.inject({
        method: 'GET',
        url: '/v1/sdk-config',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
      })
    ).json();
    expect(cfg.providers.find((p: { name: string }) => p.name === 'peopleco.test').routes).toEqual([
      '/v1/people/:id',
    ]);
    // idempotent
    expect(
      await mergeTemplates(t.db.storage, { orgId: t.orgId, projectId: t.projectId }, NOW),
    ).toEqual([]);
  });
});
