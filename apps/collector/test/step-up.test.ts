import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totpCode, totpStep } from '../src/modules/auth/totp.js';
import { Browser, FakeMailer, PASSWORD, invite, setUp, tokenFrom } from './auth-helpers.js';
import { THEIRSIDE_ADMIN_TOKEN, startTestApp, type TestApp } from './helpers.js';

const KEY = 'test-secret-key-A-0123456789abcdefghij';

/** Every action on someone else's account that needs step-up: [name, method, path suffix]. */
const ACTIONS = [
  ['reset link', 'POST', 'reset-link', { sendEmail: false }],
  ['turn off 2FA', 'POST', 'disable-2fa', {}],
  ['remove', 'DELETE', '', {}],
] as const;

const path = (id: string, suffix: string) => `/v1/admin/users/${id}${suffix ? `/${suffix}` : ''}`;

describe('step-up for changes to other users', () => {
  let t: TestApp;
  let admin: Browser;
  const mailer = new FakeMailer();
  let adminSecret = '';

  /** A fresh user with 2FA on (so every action applies), signed in. */
  async function victim(email: string) {
    const inv = await invite(admin, email);
    const b = new Browser(t);
    await b.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      password: PASSWORD,
    });
    const { secret } = (await b.req('POST', '/v1/account/2fa/setup')).json();
    await b.req('POST', '/v1/account/2fa/enable', {
      code: totpCode(secret, totpStep(t.clock.now().getTime())),
    });
    return (await b.me()).json().userId as string;
  }
  const code = (secret: string) => totpCode(secret, totpStep(t.clock.now().getTime()));

  beforeAll(async () => {
    t = await startTestApp({ env: { THEIRSIDE_SECRET_KEY: KEY }, overrides: { mailer } });
    admin = await setUp(t);
  });
  afterAll(async () => t.close());
  beforeEach(() => {
    mailer.enabled = true;
    mailer.sent = [];
    t.clock.advance(31_000); // a fresh TOTP step for each test
  });

  it.each(ACTIONS)(
    '%s: asks for the password, refuses a wrong one, keeps the session',
    async (_n, method, suffix, extra) => {
      const id = await victim(`pw-${suffix || 'remove'}@example.com`);
      const none = await admin.req(method, path(id, suffix), extra);
      expect(none.statusCode).toBe(403);
      expect(none.json()).toMatchObject({ error: 'step_up_required', needs: ['password'] });
      const wrong = await admin.req(method, path(id, suffix), {
        ...extra,
        stepUp: { password: 'not my password' },
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error).toBe('wrong_password');
      expect((await admin.me()).statusCode).toBe(200);
      const ok = await admin.req(method, path(id, suffix), {
        ...extra,
        stepUp: { password: PASSWORD },
      });
      expect(ok.statusCode).toBe(200);
    },
  );

  it('wrong step-up passwords are delayed like sign-ins', async () => {
    const id = await victim('delay@example.com');
    const b = new Browser(t, '198.51.100.70');
    await b.login('ada@example.com');
    for (let i = 0; i < 5; i++)
      await b.req('POST', path(id, 'disable-2fa'), { stepUp: { password: `nope ${i} nope` } });
    const held = await b.req('POST', path(id, 'disable-2fa'), { stepUp: { password: PASSWORD } });
    expect(held.statusCode).toBe(429);
  });

  it.each(ACTIONS)(
    '%s: with your own 2FA on, also asks for a code',
    async (_n, method, suffix, extra) => {
      if (!adminSecret) {
        const { secret } = (await admin.req('POST', '/v1/account/2fa/setup')).json();
        await admin.req('POST', '/v1/account/2fa/enable', { code: code(secret) });
        adminSecret = secret;
        t.clock.advance(30_000);
      }
      const id = await victim(`code-${suffix || 'remove'}@example.com`);
      const pwOnly = await admin.req(method, path(id, suffix), {
        ...extra,
        stepUp: { password: PASSWORD },
      });
      expect(pwOnly.json()).toMatchObject({
        error: 'step_up_required',
        needs: ['password', 'code'],
      });
      const wrong = await admin.req(method, path(id, suffix), {
        ...extra,
        stepUp: { password: PASSWORD, code: '000000' },
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error).toBe('wrong_code');
      const ok = await admin.req(method, path(id, suffix), {
        ...extra,
        stepUp: { password: PASSWORD, code: code(adminSecret) },
      });
      expect(ok.statusCode).toBe(200);
    },
  );

  it('the right password with wrong codes keeps counting', async () => {
    const id = await victim('guess@example.com');
    for (let i = 0; i < 5; i++) {
      const res = await admin.req('POST', path(id, 'disable-2fa'), {
        stepUp: { password: PASSWORD, code: String(100000 + i) },
      });
      expect(res.json().error).toBe('wrong_code');
    }
    const held = await admin.req('POST', path(id, 'disable-2fa'), {
      stepUp: { password: PASSWORD, code: code(adminSecret) },
    });
    expect(held.statusCode).toBe(429);
    t.clock.advance(Number(held.headers['retry-after']) * 1000);
    const ok = await admin.req('POST', path(id, 'disable-2fa'), {
      stepUp: { password: PASSWORD, code: code(adminSecret) },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('a session from the admin token re-enters the token; Bearer requests are not asked', async () => {
    const id = await victim('token@example.com');
    const glass = new Browser(t);
    await glass.req('POST', '/v1/auth/login', { token: THEIRSIDE_ADMIN_TOKEN });
    const none = await glass.req('POST', path(id, 'disable-2fa'));
    expect(none.json()).toMatchObject({ error: 'step_up_required', needs: ['adminToken'] });
    const wrong = await glass.req('POST', path(id, 'disable-2fa'), {
      stepUp: { adminToken: 'not-the-token' },
    });
    expect(wrong.json().error).toBe('wrong_admin_token');
    const ok = await glass.req('POST', path(id, 'disable-2fa'), {
      stepUp: { adminToken: THEIRSIDE_ADMIN_TOKEN },
    });
    expect(ok.statusCode).toBe(200);
    const bearer = await t.app.inject({
      method: 'DELETE',
      url: path(id, ''),
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    expect(bearer.statusCode).toBe(200);
  });

  it('emails the affected user, naming who did it', async () => {
    const id = await victim('told@example.com');
    mailer.sent = [];
    const step = { stepUp: { password: PASSWORD, code: code(adminSecret) } };
    const off = await admin.req('POST', path(id, 'disable-2fa'), step);
    expect(off.json()).toEqual({ ok: true, notified: true });
    t.clock.advance(30_000);
    await admin.req('POST', path(id, 'reset-link'), {
      sendEmail: false,
      stepUp: { password: PASSWORD, code: code(adminSecret) },
    });
    t.clock.advance(30_000);
    const gone = await admin.req('DELETE', path(id, ''), {
      stepUp: { password: PASSWORD, code: code(adminSecret) },
    });
    expect(gone.json()).toEqual({ notified: true });
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      ['told@example.com', 'Two-factor sign-in was turned off for your Theirside account'],
      ['told@example.com', 'A password reset link was made for your Theirside account'],
      ['told@example.com', 'Your Theirside account was removed'],
    ]);
    for (const m of mailer.sent) expect(m.text).toMatch(/^Ada \(ada@example\.com\) /);
    // the notice about a reset link doesn't contain the link
    expect(mailer.sent[1]!.text).not.toMatch(/#\/reset\//);
  });

  it('a reset link emailed to the user is the notice; without SMTP nothing is sent', async () => {
    const id = await victim('linked@example.com');
    mailer.sent = [];
    const sent = await admin.req('POST', path(id, 'reset-link'), {
      sendEmail: true,
      stepUp: { password: PASSWORD, code: code(adminSecret) },
    });
    expect(sent.json().emailed).toBe(true);
    expect(mailer.sent.map((m) => m.subject)).toEqual(['Reset your Theirside password']);
    mailer.enabled = false;
    mailer.sent = [];
    t.clock.advance(30_000);
    const off = await admin.req('POST', path(id, 'disable-2fa'), {
      stepUp: { password: PASSWORD, code: code(adminSecret) },
    });
    expect(off.json()).toEqual({ ok: true, notified: false });
    expect(mailer.sent).toHaveLength(0);
  });

  it('a failed email does not undo the change', async () => {
    const id = await victim('bounce@example.com');
    mailer.fail = true;
    try {
      const off = await admin.req('POST', path(id, 'disable-2fa'), {
        stepUp: { password: PASSWORD, code: code(adminSecret) },
      });
      expect(off.json()).toEqual({ ok: true, notified: false });
      const users = (await admin.req('GET', '/v1/admin/users')).json().users;
      expect(users.find((u: { id: string }) => u.id === id).twoFactor).toBe(false);
    } finally {
      mailer.fail = false;
    }
  });
});

describe('step-up through an identity proxy', () => {
  let t: TestApp;
  const PROXY_IP = '10.0.0.5';
  beforeAll(async () => {
    t = await startTestApp({
      env: {
        THEIRSIDE_AUTH_PROXY: 'header',
        THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: '10.0.0.0/16',
        THEIRSIDE_AUTH_PROXY_AUTO_CREATE: 'true',
      },
    });
  });
  afterAll(async () => t.close());

  it('is left to the identity provider', async () => {
    const as = (email: string) => ({ 'x-forwarded-email': email });
    const req = (method: string, url: string, headers: Record<string, string>, payload?: object) =>
      t.app.inject({
        method: method as 'GET',
        url,
        remoteAddress: PROXY_IP,
        headers,
        ...(payload ? { payload } : {}),
      });
    const ada = (await req('GET', '/v1/me', as('ada@example.com'))).json();
    const bob = (await req('GET', '/v1/me', as('bob@example.com'))).json();
    const res = await req(
      'DELETE',
      `/v1/admin/users/${bob.userId}`,
      { ...as('ada@example.com'), 'x-csrf-token': ada.csrfToken },
      {},
    );
    expect(res.statusCode).toBe(200);
  });
});
