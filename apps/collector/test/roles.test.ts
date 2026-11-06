import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/server.js';
import { MIGRATIONS_DIR, migrate } from '../src/storage/migrate.js';
import { randomBase62 } from '../src/util/ids.js';
import { Browser, FakeMailer, PASSWORD, invite, setUp, tokenFrom } from './auth-helpers.js';
import {
  ADMIN_DATABASE_URL,
  THEIRSIDE_ADMIN_TOKEN,
  batch,
  event,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

/**
 * What members may not do, as "METHOD path". Everything else under /v1/admin and
 * /v1/account is open to members. A new route lands in one list or the other by its
 * method (writes: admins) unless it says `config: { role }`; this list makes the
 * choice visible in review.
 */
const ADMIN_ONLY = [
  'DELETE /v1/admin/alert-channels/:id',
  'DELETE /v1/admin/api-keys/:id',
  'DELETE /v1/admin/status-pages/:id',
  'DELETE /v1/admin/users/:id',
  'DELETE /v1/admin/users/invites/:id',
  'GET /v1/admin/settings/security',
  'GET /v1/admin/users',
  'PATCH /v1/admin/alert-channels/:id',
  'PATCH /v1/admin/status-pages/:id',
  'POST /v1/admin/alert-channels',
  'POST /v1/admin/alert-channels/:id/test',
  'POST /v1/admin/api-keys',
  'POST /v1/admin/status-pages',
  'POST /v1/admin/users/:id/disable-2fa',
  'POST /v1/admin/users/:id/reset-link',
  'POST /v1/admin/users/:id/sign-out',
  'POST /v1/admin/users/invites',
  'PUT /v1/admin/settings/discovery',
  'PUT /v1/admin/settings/security',
  'PUT /v1/admin/settings/thresholds',
  'PUT /v1/admin/users/:id/role',
];

/** Writes members may make: providers and their own account. */
const MEMBER_WRITES = [
  'PATCH /v1/admin/providers/:id',
  'POST /v1/account/2fa/disable',
  'POST /v1/account/2fa/enable',
  'POST /v1/account/2fa/recovery-codes',
  'POST /v1/account/2fa/setup',
  'POST /v1/account/password',
  'POST /v1/account/sign-out-everywhere',
  'POST /v1/admin/providers/:id/merge',
  'POST /v1/admin/providers/:id/split',
];

/** The dashboard's routes with the role each needs, as the server decides it. */
async function dashboardRoutes(t: TestApp) {
  const probe = Fastify();
  const routes: { route: string; method: string; role: string }[] = [];
  probe.addHook('onRoute', (r) => {
    if (!/^\/v1\/(admin|account)\//.test(r.url)) return;
    for (const method of [r.method].flat()) {
      if (method === 'HEAD') continue;
      const role =
        (r.config as { role?: string } | undefined)?.role ??
        (method === 'GET' ? 'member' : 'admin');
      routes.push({ route: `${method} ${r.url}`, method, role });
    }
  });
  await registerRoutes(probe, t.ctx);
  await probe.ready();
  await probe.close();
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

const concrete = (url: string) => url.replace(/:id/g, 'nope_1234');

describe('roles: admin and member', () => {
  let t: TestApp;
  let admin: Browser;
  let member: Browser;
  let memberId: string;
  const mailer = new FakeMailer();

  beforeAll(async () => {
    t = await startTestApp({ overrides: { mailer } });
    admin = await setUp(t);
    const inv = await invite(admin, 'mia@example.com');
    member = new Browser(t);
    await member.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      name: 'Mia',
      password: PASSWORD,
    });
    memberId = (await member.me()).json().userId;
    expect((await t.app.inject(ingestRequest(batch([event()])))).statusCode).toBe(202);
  });
  afterAll(async () => t.close());

  it('the first user is an admin; invited users are members by default', async () => {
    expect((await admin.me()).json().role).toBe('admin');
    expect((await member.me()).json().role).toBe('member');
  });

  it('classifies every dashboard route', async () => {
    const routes = await dashboardRoutes(t);
    expect(routes.filter((r) => r.role === 'admin').map((r) => r.route)).toEqual(ADMIN_ONLY);
    expect(
      routes.filter((r) => r.role === 'member' && r.method !== 'GET').map((r) => r.route),
    ).toEqual(MEMBER_WRITES);
  });

  it('refuses every admin-only route to a member with 403 and a clear message', async () => {
    for (const { route, method } of (await dashboardRoutes(t)).filter((r) => r.role === 'admin')) {
      const url = concrete(route.split(' ')[1]!);
      const res = await member.req(method, url, method === 'GET' ? undefined : {});
      expect({ route, status: res.statusCode, error: res.json().error }).toEqual({
        route,
        status: 403,
        error: 'admin_only',
      });
      expect(res.json().detail).toMatch(/^Only admins can .+\. Ask an admin/);
    }
    // nothing happened: the member is still the only invitee, no key was made
    expect((await admin.req('GET', '/v1/admin/api-keys')).json().apiKeys).toHaveLength(1);
  });

  it('says which area a member was refused', async () => {
    const res = await member.req('POST', '/v1/admin/api-keys', { name: 'x', scopes: ['read'] });
    expect(res.json().detail).toBe(
      'Only admins can manage API keys. Ask an admin to do it, or to make you an admin.',
    );
  });

  it('lets a member read everything else', async () => {
    for (const { route } of (await dashboardRoutes(t)).filter(
      (r) => r.role === 'member' && r.method === 'GET' && !r.route.includes(':'),
    )) {
      // some need query parameters (400); what matters is that none is refused
      const res = await member.req('GET', route.split(' ')[1]!);
      expect({ route, refused: [401, 403].includes(res.statusCode) }).toEqual({
        route,
        refused: false,
      });
    }
    expect((await member.req('GET', '/v1/admin/overview')).statusCode).toBe(200);
  });

  it('lets a member manage providers, but not what the status page shows', async () => {
    const [p] = (await member.req('GET', '/v1/admin/providers')).json().providers;
    const rename = await member.req('PATCH', `/v1/admin/providers/${p.id}`, {
      displayName: 'Cards',
      supportEmail: 'help@acmecards.test',
      allowedPathWords: ['activate'],
      pathPrivacy: 'balanced',
      // the form sends these unchanged
      isPublic: p.isPublic,
      publicDisplayName: p.publicDisplayName,
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ displayName: 'Cards', pathPrivacy: 'balanced' });
    const pub = await member.req('PATCH', `/v1/admin/providers/${p.id}`, { isPublic: !p.isPublic });
    expect(pub.statusCode).toBe(403);
    expect(pub.json().detail).toMatch(/^Only admins can change what the status page shows/);
    const name = await member.req('PATCH', `/v1/admin/providers/${p.id}`, {
      publicDisplayName: 'Public Cards',
    });
    expect(name.statusCode).toBe(403);
    expect(
      (await admin.req('PATCH', `/v1/admin/providers/${p.id}`, { isPublic: !p.isPublic }))
        .statusCode,
    ).toBe(200);
  });

  it('lets a member manage their own account and 2FA', async () => {
    const res = await member.req('POST', '/v1/account/password', {
      currentPassword: PASSWORD,
      newPassword: 'mia has a new passphrase',
    });
    expect(res.statusCode).toBe(200);
    expect((await member.req('GET', '/v1/account/2fa')).statusCode).toBe(200);
    expect((await member.me()).json().user.email).toBe('mia@example.com');
  });

  it('changing a role needs step-up, emails the user and takes effect at once', async () => {
    const url = `/v1/admin/users/${memberId}/role`;
    expect((await admin.req('PUT', url, { role: 'admin' })).json().error).toBe('step_up_required');
    expect(
      (await admin.req('PUT', url, { role: 'boss', stepUp: { password: PASSWORD } })).statusCode,
    ).toBe(400);
    mailer.sent = [];
    const up = await admin.req('PUT', url, { role: 'admin', stepUp: { password: PASSWORD } });
    expect(up.json()).toEqual({ role: 'admin', notified: true });
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      ['mia@example.com', 'Your Theirside role is now admin'],
    ]);
    // the same session, no sign-in needed
    expect((await member.req('GET', '/v1/admin/users')).statusCode).toBe(200);
    const users = (await admin.req('GET', '/v1/admin/users')).json().users;
    expect(users.map((u: { email: string; role: string }) => [u.email, u.role])).toEqual([
      ['ada@example.com', 'admin'],
      ['mia@example.com', 'admin'],
    ]);
    // no change, no email
    mailer.sent = [];
    expect(
      (await admin.req('PUT', url, { role: 'admin', stepUp: { password: PASSWORD } })).json(),
    ).toEqual({ role: 'admin', notified: false });
    expect(mailer.sent).toHaveLength(0);
    const down = await admin.req('PUT', url, { role: 'member', stepUp: { password: PASSWORD } });
    expect(down.json().role).toBe('member');
    expect(mailer.sent.at(-1)!.subject).toBe('Your Theirside role is now member');
    expect((await member.req('GET', '/v1/admin/users')).statusCode).toBe(403);
  });
});

describe('the last admin', () => {
  let t: TestApp;
  let ada: Browser;
  let adaId: string;
  const roleOf = async (b: Browser) => (await b.me()).json().role as string;

  beforeAll(async () => {
    t = await startTestApp();
    ada = await setUp(t);
    adaId = (await ada.me()).json().userId;
  });
  afterAll(async () => t.close());

  /** A new admin, signed in. */
  async function newAdmin(email: string) {
    const inv = await invite(ada, email, 'admin');
    const b = new Browser(t);
    await b.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      password: PASSWORD,
    });
    return { b, id: (await b.me()).json().userId as string };
  }

  it("can't demote themselves", async () => {
    const res = await ada.req('PUT', `/v1/admin/users/${adaId}/role`, {
      role: 'member',
      stepUp: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'last_admin' });
    expect(res.json().detail).toMatch(/make someone else an admin/);
    expect(await roleOf(ada)).toBe('admin');
  });

  it("can't be removed, even with the admin token, while members remain", async () => {
    const inv = await invite(ada, 'member@example.com');
    const m = new Browser(t);
    await m.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      password: PASSWORD,
    });
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${adaId}`,
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('last_admin');
    // and members can't try
    expect((await m.req('DELETE', `/v1/admin/users/${adaId}`, {})).statusCode).toBe(403);
  });

  it('with another admin, either can be demoted or removed, but never both', async () => {
    const bea = await newAdmin('bea@example.com');
    const down = await bea.b.req('PUT', `/v1/admin/users/${adaId}/role`, {
      role: 'member',
      stepUp: { password: PASSWORD },
    });
    expect(down.statusCode).toBe(200);
    expect(await roleOf(ada)).toBe('member');
    const self = await bea.b.req('PUT', `/v1/admin/users/${bea.id}/role`, {
      role: 'member',
      stepUp: { password: PASSWORD },
    });
    expect(self.json().error).toBe('last_admin');
    // the admin token makes Ada an admin again (break-glass)
    const up = await t.app.inject({
      method: 'PUT',
      url: `/v1/admin/users/${adaId}/role`,
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
      payload: { role: 'admin' },
    });
    expect(up.statusCode).toBe(200);
    const removed = await ada.req('DELETE', `/v1/admin/users/${bea.id}`, {
      stepUp: { password: PASSWORD },
    });
    expect(removed.statusCode).toBe(200);
  });

  it('two admins demoting each other at the same moment: exactly one wins', async () => {
    const cy = await newAdmin('cy@example.com');
    const [a, b] = await Promise.all([
      ada.req('PUT', `/v1/admin/users/${cy.id}/role`, {
        role: 'member',
        stepUp: { password: PASSWORD },
      }),
      cy.b.req('PUT', `/v1/admin/users/${adaId}/role`, {
        role: 'member',
        stepUp: { password: PASSWORD },
      }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const { rows } = await t.db.pool.query(
      `SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.role = 'admin' AND u.auth_source <> 'system'`,
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('the setup page with THEIRSIDE_ADMIN_EMAILS set (no proxy)', () => {
  const env = { THEIRSIDE_ADMIN_EMAILS: 'someone.else@example.com' };

  it('still makes the first user an admin, even if the list leaves them out', async () => {
    const t = await startTestApp({ env });
    try {
      const ada = await setUp(t, 'ada@example.com');
      expect((await ada.me()).json()).toMatchObject({ role: 'admin', via: 'session' });
      expect((await ada.req('GET', '/v1/admin/users')).statusCode).toBe(200);
      // and the list doesn't touch password invites either
      await invite(ada, 'someone.else@example.com');
      expect((await ada.req('GET', '/v1/admin/users')).json().invites[0].role).toBe('member');
    } finally {
      await t.close();
    }
  });

  it('makes a claimed placeholder from an older bootstrap an admin', async () => {
    const t = await startTestApp({ env });
    try {
      await t.db.pool.query(
        `INSERT INTO users (id, email, name, auth_source) VALUES ('usr_old', NULL, 'Admin', 'password')`,
      );
      await t.db.pool.query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, 'usr_old', 'member')`,
        [t.orgId],
      );
      await t.db.storage.config.setMeta('bootstrap_admin_user_id', 'usr_old');
      const ada = await setUp(t, 'ada@example.com');
      expect((await ada.me()).json()).toMatchObject({ userId: 'usr_old', role: 'admin' });
    } finally {
      await t.close();
    }
  });
});

describe('identity proxy users and THEIRSIDE_ADMIN_EMAILS', () => {
  const PROXY_IP = '10.0.0.5';
  const asUser = (t: TestApp, email: string) =>
    t.app.inject({
      method: 'GET',
      url: '/v1/me',
      remoteAddress: PROXY_IP,
      headers: { 'x-forwarded-email': email },
    });
  const proxyEnv = {
    THEIRSIDE_AUTH_PROXY: 'header',
    THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: PROXY_IP,
    THEIRSIDE_AUTH_PROXY_AUTO_CREATE: 'true',
  };

  it('listed emails become admins, everyone else a member, including the first user', async () => {
    const t = await startTestApp({
      env: { ...proxyEnv, THEIRSIDE_ADMIN_EMAILS: ' Boss@Example.com , ops@example.com' },
    });
    try {
      expect((await asUser(t, 'dev@example.com')).json().role).toBe('member');
      expect((await asUser(t, 'boss@example.com')).json().role).toBe('admin');
      expect((await asUser(t, 'OPS@example.com')).json().role).toBe('admin');
      // only when the account is created: a listed email that already exists keeps its role
      expect((await asUser(t, 'dev@example.com')).json().role).toBe('member');
    } finally {
      await t.close();
    }
  });

  it("an invite's role applies to proxy sign-in; the list can only make someone an admin", async () => {
    const t = await startTestApp({
      env: {
        ...proxyEnv,
        THEIRSIDE_AUTH_PROXY_AUTO_CREATE: 'false',
        THEIRSIDE_ADMIN_EMAILS: 'lead@example.com',
      },
    });
    try {
      const admin = await setUp(t);
      await invite(admin, 'x@example.com', 'admin');
      await invite(admin, 'y@example.com');
      await invite(admin, 'lead@example.com');
      expect((await asUser(t, 'x@example.com')).json().role).toBe('admin');
      expect((await asUser(t, 'y@example.com')).json().role).toBe('member');
      expect((await asUser(t, 'lead@example.com')).json().role).toBe('admin');
    } finally {
      await t.close();
    }
  });
});

describe('migration 007', () => {
  it('makes every existing user and pending invite an admin', async () => {
    const name = `theirside_t_${randomBase62(10).toLowerCase()}`;
    const root = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
    await root.connect();
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_DATABASE_URL);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    const before = await mkdtemp(join(tmpdir(), 'theirside-migrations-'));
    try {
      for (const f of await readdir(MIGRATIONS_DIR))
        if (f < '007') await cp(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(pool, before);
      await pool.query(`INSERT INTO orgs (id, name) VALUES ('org_1', 'Org')`);
      for (const [id, role] of [
        ['usr_o', 'owner'],
        ['usr_a', 'admin'],
        ['usr_m', 'member'],
        ['usr_v', 'viewer'],
      ]) {
        await pool.query(
          `INSERT INTO users (id, email, name, auth_source) VALUES ($1, $2, $1, 'password')`,
          [id, `${id}@example.com`],
        );
        await pool.query(
          `INSERT INTO memberships (org_id, user_id, role) VALUES ('org_1', $1, $2)`,
          [id, role],
        );
      }
      await pool.query(
        `INSERT INTO auth_tokens (id, kind, token_hash, org_id, email, created_at, expires_at)
         VALUES ('inv_1', 'invite', 'h1', 'org_1', 'new@example.com', now(), now() + interval '1 day'),
                ('rst_1', 'reset', 'h2', 'org_1', 'usr_m@example.com', now(), now() + interval '1 hour')`,
      );
      expect((await migrate(pool))[0]).toBe('007_roles.sql');
      const roles = await pool.query(`SELECT DISTINCT role FROM memberships`);
      expect(roles.rows).toEqual([{ role: 'admin' }]);
      const tokens = await pool.query(`SELECT id, role FROM auth_tokens ORDER BY id`);
      expect(tokens.rows).toEqual([
        { id: 'inv_1', role: 'admin' },
        { id: 'rst_1', role: null },
      ]);
      await expect(
        pool.query(`UPDATE memberships SET role = 'owner' WHERE user_id = 'usr_o'`),
      ).rejects.toThrow(/memberships_role_check/);
    } finally {
      await pool.end();
      await rm(before, { recursive: true, force: true });
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    }
  });
});
