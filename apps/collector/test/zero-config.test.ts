import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { logRequest } from '../src/server.js';
import { Browser, PASSWORD, setUp } from './auth-helpers.js';
import {
  TEST_API_KEY,
  batch,
  event,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

/** Neither THEIRSIDE_BOOTSTRAP_API_KEY nor THEIRSIDE_ADMIN_TOKEN: the zero-config first start. */
const ZERO = { THEIRSIDE_BOOTSTRAP_API_KEY: '', THEIRSIDE_ADMIN_TOKEN: '' };
const LOCAL_V4 = '127.0.0.1';
const LOCAL_V6 = '::1';
// Docker Desktop and the userland proxy: published ports arrive from the bridge gateway
const DOCKER_GATEWAY = '172.17.0.1';

const account = (email = 'ada@example.com') => ({ email, name: 'Ada', password: PASSWORD });

async function keys(t: TestApp) {
  const { rows } = await t.db.pool.query(
    `SELECT name, scopes, visible_key, revoked_at FROM api_keys ORDER BY created_at`,
  );
  return rows;
}

async function setupMeta(t: TestApp): Promise<number> {
  const { rows } = await t.db.pool.query(
    `SELECT count(*)::int AS n FROM install_meta WHERE key LIKE 'setup_code:%'`,
  );
  return rows[0].n;
}

const rebootstrap = (t: TestApp, env: { apiKey?: string } = {}) =>
  bootstrap(t.db.storage, {
    apiKey: env.apiKey,
    generateKey: t.ctx.config.zeroConfig,
    orgName: 'Default org',
    projectName: 'Default project',
    entitlements: t.ctx.entitlements,
  });

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('zero-config first start: the project API key', () => {
  it('generates one ingest + read key, keeps it visible, and it works for ingest', async () => {
    t = await startTestApp({ env: ZERO });
    expect(t.ctx.config.zeroConfig).toBe(true);
    const rows = await keys(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Default key', scopes: ['ingest', 'read'] });
    const key = rows[0].visible_key as string;
    expect(key).toMatch(/^tsd_live_[A-Za-z0-9]{32}$/);
    expect(key).not.toBe(TEST_API_KEY);

    const res = await t.app.inject(ingestRequest(batch([event()]), key));
    expect(res.statusCode).toBe(202);
  });

  it('never creates a second key on restart, even after the first was revoked', async () => {
    t = await startTestApp({ env: ZERO });
    const again = await rebootstrap(t);
    expect(again).toMatchObject({ created: false, orgId: t.orgId, projectId: t.projectId });
    expect(again.generatedKey).toBeUndefined();
    expect(await keys(t)).toHaveLength(1);

    await t.db.pool.query(`UPDATE api_keys SET revoked_at = now(), visible_key = NULL`);
    await rebootstrap(t);
    expect(await keys(t)).toHaveLength(1);
  });

  it('shows the key to admins after setup, never to members, and forgets it on revoke', async () => {
    t = await startTestApp({ env: ZERO });
    const admin = new Browser(t, LOCAL_V4);
    expect((await admin.req('POST', '/v1/auth/setup', account())).statusCode).toBe(200);
    const listed = (await admin.req('GET', '/v1/admin/api-keys')).json().apiKeys;
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBe((await keys(t))[0].visible_key);

    const inv = await admin.req('POST', '/v1/admin/users/invites', {
      email: 'bob@example.com',
      role: 'member',
    });
    expect(inv.statusCode).toBe(201);
    const member = new Browser(t);
    const token = inv.json().url.split('/').pop();
    await member.req('POST', '/v1/auth/invite/accept', { token, name: 'Bob', password: PASSWORD });
    const seen = (await member.req('GET', '/v1/admin/api-keys')).json().apiKeys;
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('key');

    const del = await admin.req('DELETE', `/v1/admin/api-keys/${listed[0].id}`);
    expect(del.statusCode).toBe(204);
    expect((await keys(t))[0].visible_key).toBeNull();
    expect((await admin.req('GET', '/v1/admin/api-keys')).json().apiKeys[0]).not.toHaveProperty(
      'key',
    );
  });
});

describe('zero-config first start: creating the first account', () => {
  it('loopback can set up without the token', async () => {
    t = await startTestApp({ env: ZERO });
    await t.ctx.accounts.issueSetupToken();
    for (const ip of [LOCAL_V4, LOCAL_V6]) {
      const status = (await new Browser(t, ip).req('GET', '/v1/auth/status')).json();
      expect(status).toMatchObject({
        setupRequired: true,
        setup: 'open',
        adminTokenEnabled: false,
      });
    }
    const b = new Browser(t, LOCAL_V6);
    expect((await b.req('POST', '/v1/auth/setup', account())).statusCode).toBe(200);
    expect((await b.me()).json()).toMatchObject({
      role: 'admin',
      user: { email: 'ada@example.com' },
    });
  });

  it('a remote address, the Docker gateway or a forwarded request needs the token', async () => {
    t = await startTestApp({ env: ZERO });
    const token = (await t.ctx.accounts.issueSetupToken())!;
    expect(token).toMatch(/^[A-Za-z0-9]{32}$/);

    const remote = new Browser(t);
    expect((await remote.req('GET', '/v1/auth/status')).json().setup).toBe('link');
    const refused = await remote.req('POST', '/v1/auth/setup', account());
    expect(refused.statusCode).toBe(401);
    expect(refused.json().detail).toMatch(/setup link/);

    const gateway = await new Browser(t, DOCKER_GATEWAY).req('POST', '/v1/auth/setup', account());
    expect(gateway.statusCode).toBe(401);

    // a reverse proxy on the same host connects from loopback on behalf of anyone
    const forwarded: Record<string, string>[] = [
      { 'x-forwarded-for': '198.51.100.7' },
      { 'x-forwarded-for': '127.0.0.1' },
      { forwarded: 'for=198.51.100.7' },
      { 'x-real-ip': '198.51.100.7' },
    ];
    for (const header of forwarded) {
      const viaProxy = new Browser(t, LOCAL_V4);
      expect((await viaProxy.req('GET', '/v1/auth/status', undefined, header)).json().setup).toBe(
        'link',
      );
      const res = await viaProxy.req('POST', '/v1/auth/setup', account(), header);
      expect(res.statusCode).toBe(401);
    }

    const wrong = await remote.req('POST', '/v1/auth/setup', {
      ...account(),
      setupCode: 'x'.repeat(32),
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await remote.req('POST', '/v1/auth/setup', { ...account(), setupCode: token });
    expect(ok.statusCode).toBe(200);
  });

  it('the token stops working once the first account exists', async () => {
    t = await startTestApp({ env: ZERO });
    const first = (await t.ctx.accounts.issueSetupToken())!;
    // a restart before setup adds another; both work until the first account exists
    const second = (await t.ctx.accounts.issueSetupToken())!;
    t.clock.advance(30 * 24 * 3600_000);
    expect(await setupMeta(t)).toBe(2);
    const b = new Browser(t);
    expect(
      (await b.req('POST', '/v1/auth/setup', { ...account(), setupCode: second })).statusCode,
    ).toBe(200);

    expect(await setupMeta(t)).toBe(0);
    expect(await t.ctx.accounts.issueSetupToken()).toBeNull();
    for (const token of [first, second]) {
      const res = await new Browser(t).req('POST', '/v1/auth/setup', {
        ...account('eve@example.com'),
        setupCode: token,
      });
      expect(res.statusCode).toBe(409);
    }
    // loopback no longer opens anything either
    const local = await new Browser(t, LOCAL_V4).req(
      'POST',
      '/v1/auth/setup',
      account('eve@example.com'),
    );
    expect(local.statusCode).toBe(409);
    expect((await new Browser(t, LOCAL_V4).req('GET', '/v1/auth/status')).json()).toMatchObject({
      setupRequired: false,
    });
  });

  it('/setup?token= hands the token to the dashboard in the fragment, and logs redact it', async () => {
    t = await startTestApp({ env: ZERO });
    const res = await t.app.inject({ method: 'GET', url: '/setup?token=AbC123' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/#/setup/AbC123');
    expect(res.headers['cache-control']).toBe('no-store');
    const junk = await t.app.inject({ method: 'GET', url: '/setup?token=%3Cscript%3E' });
    expect(junk.headers.location).toBe('/#/setup');

    expect(logRequest({ method: 'GET', url: '/setup?token=AbC123' }).url).toBe('/setup?[redacted]');
    expect(logRequest({ method: 'GET', url: '/v1/health?range=1h' }).url).toBe(
      '/v1/health?range=1h',
    );
  });
});

describe('THEIRSIDE_BOOTSTRAP_API_KEY or THEIRSIDE_ADMIN_TOKEN set: first run as before', () => {
  it('both set: only the bootstrap key, no visible key, loopback needs the code', async () => {
    t = await startTestApp();
    expect(t.ctx.config.zeroConfig).toBe(false);
    const rows = await keys(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Bootstrap key', visible_key: null });

    const local = new Browser(t, LOCAL_V4);
    expect((await local.req('GET', '/v1/auth/status')).json()).toMatchObject({
      setup: 'code',
      adminTokenEnabled: true,
    });
    expect((await local.req('POST', '/v1/auth/setup', account())).statusCode).toBe(401);
    // the setup code flow is unchanged
    const b = await setUp(t);
    expect((await b.req('GET', '/v1/admin/api-keys')).json().apiKeys[0]).not.toHaveProperty('key');
  });

  it('only the admin token set: no key is generated and loopback needs the code', async () => {
    t = await startTestApp({ env: { THEIRSIDE_BOOTSTRAP_API_KEY: '' } });
    expect(t.ctx.config.zeroConfig).toBe(false);
    expect(await keys(t)).toHaveLength(0);
    const local = new Browser(t, LOCAL_V4);
    expect((await local.req('POST', '/v1/auth/setup', account())).statusCode).toBe(401);
  });

  it('only the bootstrap key set: that key, nothing generated, loopback needs the code', async () => {
    t = await startTestApp({ env: { THEIRSIDE_ADMIN_TOKEN: '' } });
    expect(t.ctx.config.zeroConfig).toBe(false);
    expect((await keys(t)).map((k) => k.name)).toEqual(['Bootstrap key']);
    expect(
      (await new Browser(t, LOCAL_V4).req('POST', '/v1/auth/setup', account())).statusCode,
    ).toBe(401);
  });

  it('an install that started zero-config keeps its key when the env vars are added later', async () => {
    t = await startTestApp({ env: ZERO });
    const generated = (await keys(t))[0].visible_key;
    await rebootstrap(t, { apiKey: TEST_API_KEY });
    const rows = await keys(t);
    expect(rows.map((k) => k.name)).toEqual(['Default key', 'Bootstrap key']);
    expect(rows[0].visible_key).toBe(generated);
  });

  it('a public status-page instance and the cloud are never zero-config', () => {
    const base = { DATABASE_URL: 'postgres://x/y' };
    expect(loadConfig(base).zeroConfig).toBe(true);
    expect(loadConfig({ ...base, THEIRSIDE_PUBLIC_PATHS_ONLY: 'true' }).zeroConfig).toBe(false);
    expect(loadConfig({ ...base, THEIRSIDE_DEPLOYMENT_MODE: 'cloud' }).zeroConfig).toBe(false);
  });
});
