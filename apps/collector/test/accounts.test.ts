import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, FakeMailer, PASSWORD, invite, setUp, tokenFrom } from './auth-helpers.js';
import { THEIRSIDE_ADMIN_TOKEN, startTestApp, type TestApp } from './helpers.js';

describe('first-run setup', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => t.close());

  it('is required until a user exists, then refuses a second setup', async () => {
    const b = new Browser(t);
    expect((await b.req('GET', '/v1/auth/status')).json()).toMatchObject({ setupRequired: true });
    const code = await t.ctx.accounts.issueSetupCode();
    expect(code).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);

    const wrong = await b.req('POST', '/v1/auth/setup', {
      setupCode: 'AAAA-BBBB-CCCC',
      email: 'ada@example.com',
      password: PASSWORD,
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe('invalid_setup_code');

    const weak = await b.req('POST', '/v1/auth/setup', {
      setupCode: code,
      email: 'ada@example.com',
      password: 'short',
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().detail).toMatch(/at least 12/);

    // the code is case-insensitive
    const ok = await b.req('POST', '/v1/auth/setup', {
      setupCode: code!.toLowerCase(),
      email: 'Ada@Example.com',
      name: 'Ada',
      password: PASSWORD,
    });
    expect(ok.statusCode).toBe(200);
    expect((await b.me()).json()).toMatchObject({
      via: 'session',
      user: { email: 'ada@example.com', name: 'Ada' },
    });
    expect((await b.req('GET', '/v1/auth/status')).json()).toMatchObject({ setupRequired: false });
    expect(await t.ctx.accounts.issueSetupCode()).toBeNull();

    const again = await new Browser(t).req('POST', '/v1/auth/setup', {
      adminToken: THEIRSIDE_ADMIN_TOKEN,
      email: 'eve@example.com',
      password: PASSWORD,
    });
    expect(again.statusCode).toBe(409);
    // setup codes are deleted once used
    const { rows } = await t.db.pool.query(
      `SELECT count(*)::int AS n FROM install_meta WHERE key LIKE 'setup_code:%'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('stores the password as argon2id, never in clear', async () => {
    const { rows } = await t.db.pool.query(`SELECT password_hash FROM users WHERE email = $1`, [
      'ada@example.com',
    ]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const all = JSON.stringify((await t.db.pool.query('SELECT * FROM users')).rows);
    expect(all).not.toContain(PASSWORD);
  });
});

describe('setup with the admin token, no bootstrap org, and an older install', () => {
  it('creates the org when THEIRSIDE_BOOTSTRAP_API_KEY was not set', async () => {
    const t = await startTestApp({ env: { THEIRSIDE_BOOTSTRAP_API_KEY: '' } });
    try {
      const b = new Browser(t);
      // the admin token can't sign in before there is an org
      expect(
        (await b.req('POST', '/v1/auth/login', { token: THEIRSIDE_ADMIN_TOKEN })).statusCode,
      ).toBe(409);
      const res = await b.req('POST', '/v1/auth/setup', {
        adminToken: THEIRSIDE_ADMIN_TOKEN,
        email: 'ops@example.com',
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(200);
      const me = (await b.me()).json();
      expect(me.projects).toHaveLength(1);
      expect(me.user.name).toBe('ops');
    } finally {
      await t.close();
    }
  });

  it('claims the placeholder admin that older bootstraps created', async () => {
    const t = await startTestApp();
    try {
      await t.db.pool.query(`INSERT INTO users (id, name) VALUES ('usr_old', 'Admin')`);
      await t.db.pool.query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, 'usr_old', 'owner')`,
        [t.orgId],
      );
      await t.db.storage.config.setMeta('bootstrap_admin_user_id', 'usr_old');
      const b = await setUp(t, 'old@example.com');
      expect((await b.me()).json()).toMatchObject({ userId: 'usr_old', role: 'owner' });
      const { rows } = await t.db.pool.query(`SELECT count(*)::int AS n FROM users`);
      expect(rows[0].n).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe('sign-in, sessions and CSRF', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
    await setUp(t);
  });
  afterAll(async () => t.close());

  it('signs in with email and password; secure cookie attributes', async () => {
    const b = new Browser(t);
    const res = await b.login('ADA@example.com');
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^theirside_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).not.toContain('Secure'); // plain http in tests
    expect((await b.me()).json().csrfToken).toBe(b.csrf);
    // only the token's hash is stored
    const token = decodeURIComponent(b.cookie.split('=')[1]!);
    const rows = JSON.stringify((await t.db.pool.query('SELECT * FROM sessions')).rows);
    expect(rows).not.toContain(token);
  });

  it('marks the cookie Secure behind https', async () => {
    const b = new Browser(t);
    const res = await b.req(
      'POST',
      '/v1/auth/login',
      { email: 'ada@example.com', password: PASSWORD },
      { 'x-forwarded-proto': 'https' },
    );
    expect(String(res.headers['set-cookie'])).toContain('; Secure');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const b = new Browser(t, '203.0.113.20');
    const wrong = await b.login('ada@example.com', 'not the password!');
    const unknown = await b.login('nobody@example.com', 'not the password!');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('requires the CSRF token on state-changing requests from a cookie session', async () => {
    const b = new Browser(t);
    await b.login('ada@example.com');
    const csrf = b.csrf;
    const create = (headers: Record<string, string>) =>
      b.req('POST', '/v1/admin/api-keys', { name: 'k', scopes: ['read'] }, headers);

    b.csrf = '';
    const missing = await create({});
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error).toBe('csrf');
    expect((await create({ 'x-csrf-token': 'forged' })).statusCode).toBe(403);
    // a token from another session is not accepted either
    const other = new Browser(t);
    await other.login('ada@example.com');
    expect((await create({ 'x-csrf-token': other.csrf })).statusCode).toBe(403);
    b.csrf = csrf;
    expect((await create({})).statusCode).toBe(201);
    // reads need no token
    b.csrf = '';
    expect((await b.req('GET', '/v1/admin/api-keys')).statusCode).toBe(200);
  });

  it('refuses cross-site requests even with a valid token', async () => {
    const b = new Browser(t);
    await b.login('ada@example.com');
    const post = (headers: Record<string, string>) =>
      b.req('POST', '/v1/admin/api-keys', { name: 'k', scopes: ['read'] }, headers);
    expect((await post({ origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post({ origin: 'http://localhost:80' })).statusCode).toBe(201);
    // login CSRF: a foreign page can't sign the browser in
    const login = await new Browser(t).req(
      'POST',
      '/v1/auth/login',
      { email: 'ada@example.com', password: PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(login.statusCode).toBe(403);
  });

  it('Bearer admin token needs no CSRF token (no ambient credential)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/admin/api-keys',
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
      payload: { name: 'script', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('expires sessions after 24 h idle and 7 days in total', async () => {
    const b = new Browser(t);
    await b.login('ada@example.com');
    t.clock.advance(23 * 3600_000);
    expect((await b.me()).statusCode).toBe(200);
    t.clock.advance(23 * 3600_000); // active within the idle window: still valid
    expect((await b.me()).statusCode).toBe(200);
    t.clock.advance(24 * 3600_000 + 1000);
    expect((await b.me()).statusCode).toBe(401);

    const c = new Browser(t);
    await c.login('ada@example.com');
    for (let h = 0; h < 7 * 24; h += 20) {
      t.clock.advance(20 * 3600_000);
      if (h + 20 >= 7 * 24) break;
      expect((await c.me()).statusCode, `after ${h + 20} h`).toBe(200);
    }
    expect((await c.me()).statusCode).toBe(401);
  });

  it('logs out this browser, or every browser', async () => {
    const a = new Browser(t);
    const b = new Browser(t);
    await a.login('ada@example.com');
    await b.login('ada@example.com');
    const stale = a.cookie;
    await a.req('POST', '/v1/auth/logout');
    expect(a.cookie).toBe('');
    a.cookie = stale;
    expect((await a.me()).statusCode).toBe(401);
    expect((await b.me()).statusCode).toBe(200);

    const c = new Browser(t);
    await c.login('ada@example.com');
    const out = await c.req('POST', '/v1/account/sign-out-everywhere');
    expect(out.statusCode).toBe(200);
    expect(out.json().signedOut).toBeGreaterThanOrEqual(2);
    expect((await b.me()).statusCode).toBe(401);
    expect((await c.me()).statusCode).toBe(401);
  });

  it('changing the password ends the other sessions and keeps this one', async () => {
    const a = new Browser(t);
    const b = new Browser(t);
    await a.login('ada@example.com');
    await b.login('ada@example.com');
    const bad = await a.req('POST', '/v1/account/password', {
      currentPassword: 'wrong wrong wrong',
      newPassword: 'another long passphrase',
    });
    expect(bad.statusCode).toBe(401);
    const res = await a.req('POST', '/v1/account/password', {
      currentPassword: PASSWORD,
      newPassword: 'another long passphrase',
    });
    expect(res.statusCode).toBe(200);
    expect((await a.me()).statusCode).toBe(200);
    expect((await b.me()).statusCode).toBe(401);
    expect((await new Browser(t).login('ada@example.com')).statusCode).toBe(401);
    expect(
      (await new Browser(t).login('ada@example.com', 'another long passphrase')).statusCode,
    ).toBe(200);
    await a.req('POST', '/v1/account/password', {
      currentPassword: 'another long passphrase',
      newPassword: PASSWORD,
    });
  });

  it('the admin token is break-glass: it signs in, but has no account to manage', async () => {
    const b = new Browser(t);
    expect(
      (await b.req('POST', '/v1/auth/login', { token: THEIRSIDE_ADMIN_TOKEN })).statusCode,
    ).toBe(200);
    expect((await b.me()).json()).toMatchObject({ via: 'session', role: 'owner' });
    const pw = await t.app.inject({
      method: 'POST',
      url: '/v1/account/password',
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
      payload: { currentPassword: 'x', newPassword: 'y' },
    });
    expect(pw.statusCode).toBe(400);
    // never listed as a user
    const users = (await b.req('GET', '/v1/admin/users')).json().users;
    expect(users.map((u: { email: string }) => u.email)).toEqual(['ada@example.com']);
  });
});

describe('brute-force limits', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
    await setUp(t);
  });
  afterAll(async () => t.close());

  it('locks an account for 15 minutes after 5 failures, even for the right password', async () => {
    const b = new Browser(t, '198.51.100.1');
    for (let i = 0; i < 5; i++)
      expect((await b.login('ada@example.com', `wrong password ${i}`)).statusCode).toBe(401);
    const locked = await b.login('ada@example.com');
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(14 * 60);
    expect(locked.json().error).toBe('too_many_attempts');
    // from another address too: the lock is on the account
    expect((await new Browser(t, '198.51.100.2').login('ada@example.com')).statusCode).toBe(429);
    t.clock.advance(15 * 60_000 + 1000);
    expect((await b.login('ada@example.com')).statusCode).toBe(200);
  });

  it('a success clears the account count', async () => {
    const b = new Browser(t, '198.51.100.3');
    for (let i = 0; i < 4; i++) await b.login('ada@example.com', `wrong password ${i}`);
    expect((await b.login('ada@example.com')).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await b.login('ada@example.com', `wrong password ${i}`);
    expect((await b.login('ada@example.com')).statusCode).toBe(200);
  });

  it('locks unknown emails the same way (no account enumeration)', async () => {
    const b = new Browser(t, '198.51.100.4');
    for (let i = 0; i < 5; i++) await b.login('ghost@example.com', 'whatever whatever');
    expect((await b.login('ghost@example.com', 'whatever whatever')).statusCode).toBe(429);
  });

  it('blocks an address after 30 failures across accounts (password spraying)', async () => {
    const b = new Browser(t, '198.51.100.5');
    for (let i = 0; i < 30; i++)
      expect((await b.login(`user${i}@example.com`, 'Summer2026!Summer')).statusCode).toBe(401);
    expect((await b.login('ada@example.com')).statusCode).toBe(429);
    expect((await new Browser(t, '198.51.100.6').login('ada@example.com')).statusCode).toBe(200);
  });

  it('wrong admin tokens count against the address, Bearer or login', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < 30; i++) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/v1/me',
        remoteAddress: ip,
        headers: { authorization: `Bearer guess-${i}` },
      });
      expect(res.statusCode).toBe(401);
    }
    const right = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    expect(right.statusCode).toBe(429);
    const login = await new Browser(t, ip).req('POST', '/v1/auth/login', {
      token: THEIRSIDE_ADMIN_TOKEN,
    });
    expect(login.statusCode).toBe(429);
  });

  it('counts concurrent failures exactly once each (shared across replicas)', async () => {
    const keys = await Promise.all(
      Array.from({ length: 20 }, () =>
        t.db.storage.auth.recordFailure('account:race@example.com', t.clock.now(), {
          windowMs: 60_000,
          limit: 100,
          lockMs: 60_000,
        }),
      ),
    );
    expect(Math.max(...keys.map((k) => k.failures))).toBe(20);
  });
});

describe('invites', () => {
  let t: TestApp;
  let admin: Browser;
  const mailer = new FakeMailer();
  beforeAll(async () => {
    t = await startTestApp({ overrides: { mailer } });
    admin = await setUp(t);
  });
  afterAll(async () => t.close());

  it('creates a copyable link, emails it, and the invitee signs up with it once', async () => {
    const inv = await invite(admin, 'Grace@Example.com');
    expect(inv.url).toMatch(/^http:\/\/localhost:80\/#\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(inv.emailed).toBe(true);
    expect(mailer.linkTo('grace@example.com')).toBe(inv.url);
    expect(mailer.sent.at(-1)!.text).toContain('ada@example.com invited you');

    const token = tokenFrom(inv.url);
    const g = new Browser(t);
    expect((await g.req('POST', '/v1/auth/invite/info', { token })).json()).toMatchObject({
      email: 'grace@example.com',
    });
    const accepted = await g.req('POST', '/v1/auth/invite/accept', {
      token,
      name: 'Grace',
      password: PASSWORD,
    });
    expect(accepted.statusCode).toBe(200);
    expect((await g.me()).json()).toMatchObject({ user: { email: 'grace@example.com' } });
    const again = await new Browser(t).req('POST', '/v1/auth/invite/accept', {
      token,
      password: PASSWORD,
    });
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toBe('link_used');
    // invite tokens are stored hashed
    const rows = JSON.stringify((await t.db.pool.query('SELECT * FROM auth_tokens')).rows);
    expect(rows).not.toContain(token);
  });

  it('expires after 7 days', async () => {
    const inv = await invite(admin, 'late@example.com');
    t.clock.advance(7 * 24 * 3600_000 + 1000);
    const res = await new Browser(t).req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('link_expired');
    // the admin session has been idle: sign in again
    await admin.login('ada@example.com');
  });

  it('rejects unknown tokens and counts them against the address', async () => {
    const b = new Browser(t, '192.0.2.50');
    const res = await b.req('POST', '/v1/auth/invite/info', { token: 'x'.repeat(43) });
    expect(res.statusCode).toBe(404);
    for (let i = 0; i < 29; i++) await b.req('POST', '/v1/auth/invite/info', { token: `t${i}` });
    expect((await b.req('POST', '/v1/auth/invite/info', { token: 'y' })).statusCode).toBe(429);
  });

  it('refuses existing users, replaces older invites, can be revoked, and lists pending ones', async () => {
    expect(
      (await admin.req('POST', '/v1/admin/users/invites', { email: 'ada@example.com' })).statusCode,
    ).toBe(409);
    expect(
      (await admin.req('POST', '/v1/admin/users/invites', { email: 'not-an-email' })).statusCode,
    ).toBe(400);
    const first = await invite(admin, 'lin@example.com');
    const second = await invite(admin, 'lin@example.com');
    expect(
      (await new Browser(t).req('POST', '/v1/auth/invite/info', { token: tokenFrom(first.url) }))
        .statusCode,
    ).toBe(404);
    const list = (await admin.req('GET', '/v1/admin/users')).json();
    expect(list.invites.map((i: { email: string }) => i.email)).toContain('lin@example.com');
    expect(list.emailEnabled).toBe(true);
    expect((await admin.req('DELETE', `/v1/admin/users/invites/${second.id}`)).statusCode).toBe(
      204,
    );
    expect(
      (await new Browser(t).req('POST', '/v1/auth/invite/info', { token: tokenFrom(second.url) }))
        .statusCode,
    ).toBe(404);
  });

  it('still returns the link when the email fails, or when asked not to email', async () => {
    mailer.fail = true;
    const inv = await invite(admin, 'mail-down@example.com');
    expect(inv.emailed).toBe(false);
    expect(inv.emailError).toMatch(/unreachable/);
    expect(inv.url).toContain('#/invite/');
    mailer.fail = false;
    const n = mailer.sent.length;
    const quiet = await admin.req('POST', '/v1/admin/users/invites', {
      email: 'quiet@example.com',
      sendEmail: false,
    });
    expect(quiet.json().emailed).toBe(false);
    expect(mailer.sent.length).toBe(n);
  });

  it('invited users are equal: they can invite and manage users too', async () => {
    const g = new Browser(t);
    await g.login('grace@example.com');
    expect(
      (await g.req('POST', '/v1/admin/users/invites', { email: 'third@example.com' })).statusCode,
    ).toBe(201);
  });
});

describe('password reset', () => {
  let t: TestApp;
  let admin: Browser;
  let userId: string;
  const mailer = new FakeMailer();
  beforeAll(async () => {
    t = await startTestApp({ overrides: { mailer } });
    admin = await setUp(t);
    const inv = await invite(admin, 'bob@example.com');
    const b = new Browser(t);
    await b.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      password: PASSWORD,
    });
    userId = (await b.me()).json().userId;
  });
  afterAll(async () => t.close());

  it('admin-generated link: one use, signs the user out everywhere, lifts a lockout', async () => {
    const bob = new Browser(t);
    await bob.login('bob@example.com');
    for (let i = 0; i < 5; i++)
      await new Browser(t, '192.0.2.9').login('bob@example.com', 'nope nope nope');
    expect((await new Browser(t).login('bob@example.com')).statusCode).toBe(429);

    const link = await admin.req('POST', `/v1/admin/users/${userId}/reset-link`, {
      sendEmail: false,
    });
    expect(link.statusCode).toBe(200);
    const { url, emailed } = link.json();
    expect(emailed).toBe(false);
    const token = tokenFrom(url);
    expect(
      (await new Browser(t).req('POST', '/v1/auth/password-reset/info', { token })).json(),
    ).toMatchObject({
      email: 'bob@example.com',
    });
    const weak = await new Browser(t).req('POST', '/v1/auth/password-reset', {
      token,
      password: 'short',
    });
    expect(weak.statusCode).toBe(400);
    const res = await new Browser(t).req('POST', '/v1/auth/password-reset', {
      token,
      password: 'a brand new passphrase',
    });
    expect(res.statusCode).toBe(200);
    expect((await bob.me()).statusCode).toBe(401);
    expect((await new Browser(t).login('bob@example.com')).statusCode).toBe(401);
    expect(
      (await new Browser(t).login('bob@example.com', 'a brand new passphrase')).statusCode,
    ).toBe(200);
    const reuse = await new Browser(t).req('POST', '/v1/auth/password-reset', {
      token,
      password: PASSWORD,
    });
    expect(reuse.statusCode).toBe(410);
  });

  it('expires after 1 hour, and a newer link replaces the older one', async () => {
    const one = tokenFrom(
      (await admin.req('POST', `/v1/admin/users/${userId}/reset-link`, { sendEmail: false })).json()
        .url,
    );
    const two = tokenFrom(
      (await admin.req('POST', `/v1/admin/users/${userId}/reset-link`, { sendEmail: false })).json()
        .url,
    );
    expect(
      (await new Browser(t).req('POST', '/v1/auth/password-reset/info', { token: one })).statusCode,
    ).toBe(404);
    t.clock.advance(3600_000 + 1000);
    const late = await new Browser(t).req('POST', '/v1/auth/password-reset', {
      token: two,
      password: PASSWORD,
    });
    expect(late.statusCode).toBe(410);
    expect(late.json().error).toBe('link_expired');
    await admin.login('ada@example.com');
  });

  it('by email: same answer for unknown addresses, rate-limited per address', async () => {
    const b = new Browser(t);
    const n = mailer.sent.length;
    expect(
      (
        await b.req('POST', '/v1/auth/password-reset/request', { email: 'nobody@example.com' })
      ).json(),
    ).toEqual({ ok: true });
    expect(mailer.sent.length).toBe(n);
    expect(
      (await b.req('POST', '/v1/auth/password-reset/request', { email: 'bob@example.com' })).json(),
    ).toEqual({ ok: true });
    const url = mailer.linkTo('bob@example.com');
    expect(url).toContain('#/reset/');
    const res = await new Browser(t).req('POST', '/v1/auth/password-reset', {
      token: tokenFrom(url),
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(200);
    for (let i = 0; i < 5; i++)
      await b.req('POST', '/v1/auth/password-reset/request', { email: 'bob@example.com' });
    // 3 emails per address per hour, then silently nothing
    expect(
      mailer.sent.filter((m) => m.to === 'bob@example.com' && m.subject.includes('Reset')).length,
    ).toBe(3);
  });

  it('without SMTP there is no self-service reset', async () => {
    mailer.enabled = false;
    const res = await new Browser(t).req('POST', '/v1/auth/password-reset/request', {
      email: 'bob@example.com',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('email_disabled');
    mailer.enabled = true;
  });
});

describe('managing users', () => {
  let t: TestApp;
  let admin: Browser;
  beforeAll(async () => {
    t = await startTestApp();
    admin = await setUp(t);
  });
  afterAll(async () => t.close());

  it('lists users without secrets, signs a user out, removes users but never yourself or the last one', async () => {
    const me = (await admin.me()).json().userId;
    expect((await admin.req('DELETE', `/v1/admin/users/${me}`)).statusCode).toBe(400);
    const inv = await invite(admin, 'kim@example.com');
    const kim = new Browser(t);
    await kim.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      password: PASSWORD,
    });
    const list = await admin.req('GET', '/v1/admin/users');
    expect(JSON.stringify(list.json())).not.toMatch(/argon2|password_hash|passwordHash/);
    const kimRow = list.json().users.find((u: { email: string }) => u.email === 'kim@example.com');
    expect(kimRow).toMatchObject({ source: 'password', hasPassword: true, activeSessions: 1 });

    expect((await admin.req('POST', `/v1/admin/users/${kimRow.id}/sign-out`)).json()).toEqual({
      signedOut: 1,
    });
    expect((await kim.me()).statusCode).toBe(401);

    await kim.login('kim@example.com');
    expect((await kim.req('DELETE', `/v1/admin/users/${me}`)).statusCode).toBe(204);
    expect((await admin.me()).statusCode).toBe(401);
    // kim is now the last user
    const adminToken = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };
    const last = await t.app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${kimRow.id}`,
      headers: adminToken,
    });
    expect(last.statusCode).toBe(409);
    expect(
      (
        await t.app.inject({
          method: 'DELETE',
          url: '/v1/admin/users/usr_unknown',
          headers: adminToken,
        })
      ).statusCode,
    ).toBe(404);
  });
});
