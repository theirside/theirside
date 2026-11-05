import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { DEV_LICENSE_PRIVATE_KEY } from '../src/modules/entitlements/dev-keys.js';
import { signLicense } from '../src/modules/entitlements/license.js';
import {
  batch,
  createTestDb,
  event,
  ingestRequest,
  startTestApp,
  THEIRSIDE_ADMIN_TOKEN,
  TEST_API_KEY,
  type TestApp,
  type TestDb,
} from './helpers.js';

const asAdmin =
  (t: TestApp) => (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
      ...(payload ? { payload } : {}),
    });

describe('API keys (Settings → API keys)', () => {
  let t: TestApp;
  let admin: ReturnType<typeof asAdmin>;
  beforeAll(async () => {
    t = await startTestApp();
    admin = asAdmin(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('requires login', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/admin/api-keys' })).statusCode).toBe(401);
  });

  it('lists keys by prefix, never the key itself', async () => {
    const res = await admin('GET', '/v1/admin/api-keys');
    expect(res.statusCode).toBe(200);
    const keys = res.json().apiKeys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: 'Bootstrap key',
      keyPrefix: 'tsd_live_test',
      revokedAt: null,
    });
    expect(keys[0].scopes.sort()).toEqual(['ingest', 'read']);
    expect(res.body).not.toContain(TEST_API_KEY);
  });

  it('creates a key shown once, which works at once and stops at once when revoked', async () => {
    const created = await admin('POST', '/v1/admin/api-keys', {
      name: 'payments-api',
      scopes: ['ingest'],
    });
    expect(created.statusCode).toBe(201);
    const { key, id, keyPrefix } = created.json();
    expect(key).toMatch(/^tsd_live_[A-Za-z0-9]{32}$/);
    expect(key.startsWith(keyPrefix)).toBe(true);
    expect((await admin('GET', '/v1/admin/api-keys')).body).not.toContain(key);

    expect((await t.app.inject(ingestRequest(batch([event()]), key))).statusCode).toBe(202);
    // ingest-only: no read access
    const read = await t.app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(read.statusCode).toBe(401);

    expect((await admin('DELETE', `/v1/admin/api-keys/${id}`)).statusCode).toBe(204);
    expect((await t.app.inject(ingestRequest(batch([event()]), key))).statusCode).toBe(401);
    const listed = (await admin('GET', '/v1/admin/api-keys')).json().apiKeys;
    expect(listed.find((k: { id: string }) => k.id === id).revokedAt).not.toBeNull();
    expect((await admin('DELETE', `/v1/admin/api-keys/${id}`)).statusCode).toBe(404);
  });

  it.each([
    [{ name: '', scopes: ['ingest'] }],
    [{ name: 'x', scopes: [] }],
    [{ name: 'x', scopes: ['admin'] }],
  ])('validates %j', async (body) => {
    expect((await admin('POST', '/v1/admin/api-keys', body)).statusCode).toBe(400);
  });

  it('a revoked bootstrap key stays revoked across restarts', async () => {
    const boot = (await admin('GET', '/v1/admin/api-keys'))
      .json()
      .apiKeys.find((k: { name: string }) => k.name === 'Bootstrap key');
    expect((await admin('DELETE', `/v1/admin/api-keys/${boot.id}`)).statusCode).toBe(204);
    await bootstrap(t.db.storage, {
      apiKey: TEST_API_KEY,
      orgName: 'x',
      projectName: 'y',
      entitlements: t.ctx.entitlements,
    });
    t.ctx.apiKeys.invalidate();
    expect((await t.app.inject(ingestRequest(batch([event()])))).statusCode).toBe(401);
  });

  it('only owners and admins create or revoke keys', async () => {
    await t.db.pool.query(`UPDATE memberships SET role = 'viewer'`);
    expect(
      (await admin('POST', '/v1/admin/api-keys', { name: 'x', scopes: ['read'] })).statusCode,
    ).toBe(403);
    await t.db.pool.query(`UPDATE memberships SET role = 'owner'`);
  });
});

describe('status pages (Settings → Status page)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('free edition: one page, and creating another explains the limit', async () => {
    const t = await startTestApp({ db });
    const admin = asAdmin(t);
    const list = (await admin('GET', '/v1/admin/status-pages')).json();
    expect(list).toMatchObject({ limit: 1, used: 1, canCreate: false });
    expect(list.limitMessage).toMatch(
      /includes 1 status page\. More status pages need a licence key/,
    );
    const res = await admin('POST', '/v1/admin/status-pages', { title: 'Second' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'status_page_limit', limit: 1 });
    expect(res.json().detail).toMatch(/licence key/);
    await t.close();
  });

  it('with maxStatusPages from a licence: create, edit, delete up to the limit', async () => {
    const now = Date.now() / 1000;
    const lic = signLicense(
      {
        iss: 'theirside',
        sub: 'Example Co',
        plan: 'business',
        iat: now - 60,
        exp: now + 86400,
        ent: { maxStatusPages: 2 },
      },
      DEV_LICENSE_PRIVATE_KEY,
    );
    const t = await startTestApp({
      db,
      env: { THEIRSIDE_LICENSE_KEY: lic, THEIRSIDE_ALLOW_DEV_LICENSE: '1' },
    });
    const admin = asAdmin(t);
    await db.storage.config.upsertProvider(
      { orgId: t.orgId, projectId: t.projectId },
      {
        name: 'Acme Cards',
        hostPatterns: ['api.acmecards.test'],
        explicitRoutes: [],
        supportEmail: null,
        supportUrl: null,
        supportNotes: null,
        publicDisplayName: 'Card issuing',
        isPublic: true,
      },
    );

    const created = await admin('POST', '/v1/admin/status-pages', {
      title: 'Partner status',
      providerFilter: ['Acme Cards'],
      theme: 'dark',
    });
    expect(created.statusCode).toBe(201);
    const page = created.json();
    expect(page).toMatchObject({
      title: 'Partner status',
      providerFilter: ['Acme Cards'],
      theme: 'dark',
    });
    expect(page.embedSnippet).toContain(`data-token="${page.publicToken}"`);
    expect(page.url).toMatch(new RegExp(`/status/${page.publicToken}$`));
    expect((await admin('GET', '/v1/admin/status-pages')).json()).toMatchObject({
      limit: 2,
      used: 2,
      canCreate: false,
    });
    expect((await admin('POST', '/v1/admin/status-pages', { title: 'Third' })).statusCode).toBe(
      403,
    );

    const patched = await admin('PATCH', `/v1/admin/status-pages/${page.id}`, {
      title: 'Card issuing status',
    });
    expect(patched.json()).toMatchObject({ title: 'Card issuing status', theme: 'dark' });
    const html = (await t.app.inject({ method: 'GET', url: `/status/${page.publicToken}` })).body;
    expect(html).toContain('Card issuing status');
    expect(html).toContain('Card issuing');

    expect((await admin('DELETE', `/v1/admin/status-pages/${page.id}`)).statusCode).toBe(204);
    expect((await admin('GET', '/v1/admin/status-pages')).json()).toMatchObject({
      used: 1,
      canCreate: true,
    });
    expect(
      (await admin('PATCH', `/v1/admin/status-pages/${page.id}`, { title: 'x' })).statusCode,
    ).toBe(404);
    await t.close();
  });

  it('validates input', async () => {
    const t = await startTestApp({ db });
    const admin = asAdmin(t);
    const id = (await admin('GET', '/v1/admin/status-pages')).json().statusPages[0].id;
    expect(
      (await admin('PATCH', `/v1/admin/status-pages/${id}`, { theme: 'neon' })).statusCode,
    ).toBe(400);
    expect((await admin('PATCH', `/v1/admin/status-pages/${id}`, { title: '' })).statusCode).toBe(
      400,
    );
    await t.close();
  });
});
