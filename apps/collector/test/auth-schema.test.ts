import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { keyPrefixForDisplay } from '../src/modules/auth/api-keys.js';
import { migrate } from '../src/storage/migrate.js';
import { THEIRSIDE_ADMIN_TOKEN, TEST_API_KEY, startTestApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('schema', () => {
  it('migrations are idempotent', async () => {
    expect(await migrate(t.db.pool)).toEqual([]);
  });

  it('every tenant-owned table carries org_id (hard rule 4)', async () => {
    const { rows } = await t.db.pool.query(`
      SELECT c.relname AS table,
             bool_or(a.attname = 'org_id') AS has_org,
             bool_or(a.attname = 'project_id') AS has_project
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
       GROUP BY c.relname ORDER BY c.relname`);
    // not tenant-owned: the tenants themselves, global users, install metadata, migration bookkeeping
    const global = new Set([
      'orgs',
      'users',
      'install_meta',
      'schema_migrations',
      // a user's sessions and recovery codes, and sign-in throttling keyed by email/address
      'sessions',
      'auth_throttle',
      'user_recovery_codes',
    ]);
    const orgOnly = new Set(['memberships', 'projects', 'auth_tokens']);
    for (const r of rows) {
      if (global.has(r.table)) continue;
      expect(r.has_org, `${r.table} has org_id`).toBe(true);
      if (!orgOnly.has(r.table)) expect(r.has_project, `${r.table} has project_id`).toBe(true);
    }
    expect(rows.map((r) => r.table)).toEqual(
      expect.arrayContaining([
        'events',
        'rollups_1m',
        'incidents',
        'usage_daily',
        'sdk_instances',
        'api_keys',
      ]),
    );
  });

  it('stores API keys hashed, never in clear', async () => {
    const { rows } = await t.db.pool.query('SELECT * FROM api_keys');
    expect(JSON.stringify(rows)).not.toContain(TEST_API_KEY);
    expect(rows[0].key_prefix).toBe(keyPrefixForDisplay(TEST_API_KEY));
    expect(rows[0].key_prefix).toBe('tsd_live_test');
  });
});

describe('bootstrap', () => {
  it('created one org, project, key and status page, and no user (setup page makes the first)', async () => {
    const q = async (sql: string) => (await t.db.pool.query(sql)).rows;
    expect(await q('SELECT count(*)::int AS n FROM orgs')).toEqual([{ n: 1 }]);
    expect(await q('SELECT count(*)::int AS n FROM users')).toEqual([{ n: 0 }]);
    expect(await q('SELECT count(*)::int AS n FROM status_pages')).toEqual([{ n: 1 }]);
    expect((await q('SELECT scopes FROM api_keys'))[0].scopes.sort()).toEqual(['ingest', 'read']);
  });

  it('is idempotent on restart', async () => {
    const again = await bootstrap(t.db.storage, {
      apiKey: TEST_API_KEY,
      orgName: 'x',
      projectName: 'y',
      entitlements: t.ctx.entitlements,
    });
    expect(again.created).toBe(false);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM orgs')).rows[0].n).toBe(1);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM api_keys')).rows[0].n).toBe(1);
  });

  it('rejects a malformed THEIRSIDE_BOOTSTRAP_API_KEY', async () => {
    await expect(
      bootstrap(t.db.storage, {
        apiKey: 'short',
        orgName: 'x',
        projectName: 'y',
        entitlements: t.ctx.entitlements,
      }),
    ).rejects.toThrow(/tsd_live_/);
  });
});

describe('THEIRSIDE_ADMIN_TOKEN login (break-glass)', () => {
  it('signs in as the admin-token system user, an owner of the org', async () => {
    const login = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { token: THEIRSIDE_ADMIN_TOKEN },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(login.headers['set-cookie'])).toContain('SameSite=Strict');

    const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      orgId: t.orgId,
      role: 'owner',
      via: 'session',
      entitlements: { plan: 'oss' },
    });
    expect(me.json().projects).toEqual([{ id: t.projectId, name: 'Default project' }]);
  });

  it('accepts Bearer THEIRSIDE_ADMIN_TOKEN for scripts', async () => {
    const me = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it.each([
    ['wrong token', { token: 'nope' }],
    ['no token', {}],
  ])('rejects %s', async (_n, payload) => {
    expect(
      (await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload })).statusCode,
    ).toBe(401);
  });

  it('rejects unknown, tampered and expired session cookies', async () => {
    const login = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { token: THEIRSIDE_ADMIN_TOKEN },
    });
    const value = decodeURIComponent(
      String(login.headers['set-cookie']).split(';')[0]!.split('=')[1]!,
    );
    const me = (cookie: string) =>
      t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect((await me(`theirside_session=${value}`)).statusCode).toBe(200);
    const tampered = value.slice(0, -2) + (value.endsWith('AA') ? 'BB' : 'AA');
    expect((await me(`theirside_session=${tampered}`)).statusCode).toBe(401);
    expect((await me('theirside_session=nonsense')).statusCode).toBe(401);
    t.clock.advance(8 * 24 * 3600 * 1000);
    expect((await me(`theirside_session=${value}`)).statusCode).toBe(401);
  });

  it('health endpoints', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({
      status: 'ok',
      db: 'ok',
    });
    expect((await t.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });
});
