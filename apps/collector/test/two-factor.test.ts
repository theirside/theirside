import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/modules/auth/secret-box.js';
import {
  base32Encode,
  matchTotp,
  newRecoveryCode,
  normalizeRecoveryCode,
  totpCode,
  totpStep,
} from '../src/modules/auth/totp.js';
import { Browser, PASSWORD, invite, setUp, tokenFrom } from './auth-helpers.js';
import { THEIRSIDE_ADMIN_TOKEN, createTestDb, startTestApp, type TestApp } from './helpers.js';

const KEY_A = 'test-secret-key-A-0123456789abcdefghij';
const KEY_B = 'test-secret-key-B-0123456789abcdefghij';

/** The current code for a secret at the test clock's time (offset in 30 s steps). */
const codeAt = (t: TestApp, secret: string, offset = 0) =>
  totpCode(secret, totpStep(t.clock.now().getTime()) + offset);

/** Turn 2FA on for the signed-in browser; returns the secret and recovery codes. */
async function enrol(t: TestApp, b: Browser) {
  const setup = await b.req('POST', '/v1/account/2fa/setup');
  expect(setup.statusCode).toBe(200);
  const { secret } = setup.json();
  const enable = await b.req('POST', '/v1/account/2fa/enable', { code: codeAt(t, secret) });
  expect(enable.statusCode).toBe(200);
  t.clock.advance(30_000); // the enrolment code can't be reused for sign-in
  return { secret: secret as string, recoveryCodes: enable.json().recoveryCodes as string[] };
}

/** Password, then the second step. */
async function login2fa(t: TestApp, email: string, code: string, ip?: string) {
  const b = new Browser(t, ip);
  const first = await b.login(email);
  expect(first.statusCode).toBe(200);
  expect(first.json().mfaRequired).toBe(true);
  expect(first.headers['set-cookie']).toBeUndefined();
  const second = await b.req('POST', '/v1/auth/login/2fa', {
    mfaToken: first.json().mfaToken,
    code,
  });
  return { b, res: second, mfaToken: first.json().mfaToken as string };
}

describe('TOTP and the secret box', () => {
  it('matches the RFC 6238 test vectors (SHA-1, 6 digits)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpCode(secret, totpStep(59_000))).toBe('287082');
    expect(totpCode(secret, totpStep(1_111_111_109_000))).toBe('081804');
    expect(totpCode(secret, totpStep(2_000_000_000_000))).toBe('279037');
    // ±1 step of drift, not 2
    const now = 1_111_111_109_000;
    expect(matchTotp(secret, totpCode(secret, totpStep(now) - 1), now)).toBe(totpStep(now) - 1);
    expect(matchTotp(secret, totpCode(secret, totpStep(now) + 1), now)).toBe(totpStep(now) + 1);
    expect(matchTotp(secret, totpCode(secret, totpStep(now) - 2), now)).toBeNull();
    expect(matchTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('recovery codes: 16 unambiguous characters, normalized for typing', () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}(-[A-HJKMNP-TV-Z2-9]{4}){3}$/);
    expect(normalizeRecoveryCode(` ${code.toLowerCase().replaceAll('-', ' ')} `)).toBe(
      code.replaceAll('-', ''),
    );
  });

  it('encrypts with AES-GCM bound to the user, and decrypts with previous keys', () => {
    const a = new SecretBox(KEY_A);
    const enc = a.encrypt('JBSWY3DPEHPK3PXP', 'usr_1');
    expect(enc).toMatch(/^v1\.[0-9a-f]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(a.decrypt(enc, 'usr_1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => a.decrypt(enc, 'usr_2')).toThrow(); // moved to another user
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => a.decrypt(parts.join('.'), 'usr_1')).toThrow();
    expect(() => new SecretBox(KEY_B).decrypt(enc, 'usr_1')).toThrow(/THEIRSIDE_SECRET_KEY/);
    const rotated = new SecretBox(KEY_B, [KEY_A]);
    expect(rotated.decrypt(enc, 'usr_1')).toBe('JBSWY3DPEHPK3PXP');
    expect(rotated.isStale(enc)).toBe(true);
    expect(rotated.isStale(rotated.encrypt('x', 'usr_1'))).toBe(false);
    expect(new SecretBox(undefined).configured).toBe(false);
  });
});

describe('two-factor sign-in', () => {
  let t: TestApp;
  let admin: Browser;
  let secret: string;
  let recoveryCodes: string[];
  beforeAll(async () => {
    t = await startTestApp({ env: { THEIRSIDE_SECRET_KEY: KEY_A } });
    admin = await setUp(t);
    ({ secret, recoveryCodes } = await enrol(t, admin));
  });
  afterAll(async () => t.close());

  it('stores the secret encrypted and the recovery codes hashed', async () => {
    expect(recoveryCodes).toHaveLength(10);
    const users = JSON.stringify((await t.db.pool.query('SELECT * FROM users')).rows);
    expect(users).not.toContain(secret);
    expect(users).toMatch(/"totp_secret_enc":"v1\./);
    const codes = JSON.stringify((await t.db.pool.query('SELECT * FROM user_recovery_codes')).rows);
    for (const c of recoveryCodes) {
      expect(codes).not.toContain(c);
      expect(codes).not.toContain(c.replaceAll('-', ''));
    }
    expect((await admin.req('GET', '/v1/account/2fa')).json()).toMatchObject({
      enabled: true,
      recoveryCodesLeft: 10,
      available: true,
    });
  });

  it('refuses a wrong code at enrolment', async () => {
    const inv = await invite(admin, 'wrong@example.com');
    const b = new Browser(t);
    await b.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      password: PASSWORD,
    });
    const setup = (await b.req('POST', '/v1/account/2fa/setup')).json();
    const wrong = codeAt(t, setup.secret) === '000000' ? '111111' : '000000';
    expect((await b.req('POST', '/v1/account/2fa/enable', { code: wrong })).statusCode).toBe(400);
    expect((await b.req('GET', '/v1/account/2fa')).json().enabled).toBe(false);
  });

  it('asks for a code after the password; the session starts only after it', async () => {
    const { b, res } = await login2fa(t, 'ada@example.com', codeAt(t, secret));
    expect(res.statusCode).toBe(200);
    expect((await b.me()).json().twoFactor).toEqual({ enabled: true, enrollmentRequired: false });
  });

  it('accepts each code once (no replay), and the one-step drift', async () => {
    t.clock.advance(30_000);
    const code = codeAt(t, secret);
    expect((await login2fa(t, 'ada@example.com', code)).res.statusCode).toBe(200);
    expect((await login2fa(t, 'ada@example.com', code)).res.statusCode).toBe(401);
    t.clock.advance(30_000);
    expect((await login2fa(t, 'ada@example.com', codeAt(t, secret, -1))).res.statusCode).toBe(401); // already-used step
    expect((await login2fa(t, 'ada@example.com', codeAt(t, secret, 1))).res.statusCode).toBe(200);
    t.clock.advance(90_000);
  });

  it('a recovery code works once, typed any way', async () => {
    const code = recoveryCodes[0]!;
    const typed = ` ${code.toLowerCase().replaceAll('-', ' ')} `;
    expect((await login2fa(t, 'ada@example.com', typed)).res.statusCode).toBe(200);
    expect((await login2fa(t, 'ada@example.com', code)).res.statusCode).toBe(401);
    expect((await admin.req('GET', '/v1/account/2fa')).json().recoveryCodesLeft).toBe(9);
  });

  it('the second step token works once and expires after 5 minutes', async () => {
    const { mfaToken, res } = await login2fa(t, 'ada@example.com', codeAt(t, secret));
    expect(res.statusCode).toBe(200);
    t.clock.advance(30_000);
    const reuse = await new Browser(t).req('POST', '/v1/auth/login/2fa', {
      mfaToken,
      code: codeAt(t, secret),
    });
    expect(reuse.statusCode).toBe(410);

    const b = new Browser(t);
    const first = (await b.login('ada@example.com')).json();
    t.clock.advance(5 * 60_000 + 1000);
    const late = await b.req('POST', '/v1/auth/login/2fa', {
      mfaToken: first.mfaToken,
      code: codeAt(t, secret),
    });
    expect(late.statusCode).toBe(410);
    expect(late.json().error).toBe('link_expired');
  });

  it('wrong codes delay that address like wrong passwords, even for the right code', async () => {
    const b = new Browser(t, '198.51.100.40');
    const { mfaToken } = (await b.login('ada@example.com')).json();
    for (let i = 0; i < 5; i++) {
      const res = await b.req('POST', '/v1/auth/login/2fa', { mfaToken, code: '000000' });
      expect(res.statusCode).toBe(401);
    }
    const held = await b.req('POST', '/v1/auth/login/2fa', { mfaToken, code: codeAt(t, secret) });
    expect(held.statusCode).toBe(429);
    // the password step at that address waits too; another address doesn't
    expect((await new Browser(t, '198.51.100.40').login('ada@example.com')).statusCode).toBe(429);
    expect((await new Browser(t, '198.51.100.41').login('ada@example.com')).statusCode).toBe(200);
    t.clock.advance(Number(held.headers['retry-after']) * 1000);
    const ok = await b.req('POST', '/v1/auth/login/2fa', { mfaToken, code: codeAt(t, secret) });
    expect(ok.statusCode).toBe(200);
  });

  it('turning 2FA off and new recovery codes need the password', async () => {
    t.clock.advance(30_000); // the previous test used this step's code
    const { b, res } = await login2fa(t, 'ada@example.com', codeAt(t, secret));
    expect(res.statusCode).toBe(200);
    expect(
      (await b.req('POST', '/v1/account/2fa/recovery-codes', { password: 'nope nope nope' }))
        .statusCode,
    ).toBe(403);
    const fresh = await b.req('POST', '/v1/account/2fa/recovery-codes', { password: PASSWORD });
    expect(fresh.json().recoveryCodes).toHaveLength(10);
    // the old ones stop working
    expect((await login2fa(t, 'ada@example.com', recoveryCodes[1]!)).res.statusCode).toBe(401);
    recoveryCodes = fresh.json().recoveryCodes;
    expect(
      (await b.req('POST', '/v1/account/2fa/disable', { password: 'nope nope nope' })).statusCode,
    ).toBe(403);
    // a wrong confirmation is not a lost session
    expect((await b.me()).statusCode).toBe(200);
  });
});

describe('requiring 2FA for everyone', () => {
  let t: TestApp;
  let admin: Browser;
  let bob: Browser;
  let bobId: string;
  let adminSecret: string;
  beforeAll(async () => {
    t = await startTestApp({ env: { THEIRSIDE_SECRET_KEY: KEY_A } });
    admin = await setUp(t);
    const inv = await invite(admin, 'bob@example.com');
    bob = new Browser(t);
    await bob.req('POST', '/v1/auth/invite/accept', {
      token: tokenFrom(inv.url),
      password: PASSWORD,
    });
    bobId = (await bob.me()).json().userId;
  });
  afterAll(async () => t.close());

  it('can only be switched on by someone who has 2FA', async () => {
    const res = await admin.req('PUT', '/v1/admin/settings/security', { require2fa: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('enable_2fa_first');
    adminSecret = (await enrol(t, admin)).secret;
    expect(
      (await admin.req('PUT', '/v1/admin/settings/security', { require2fa: true })).statusCode,
    ).toBe(200);
    expect((await admin.req('GET', '/v1/admin/settings/security')).json()).toEqual({
      require2fa: true,
      secretKeyConfigured: true,
      passwordUsersWithout2fa: 1,
    });
  });

  it('limits users without 2FA to setting it up, at once and on every session', async () => {
    const me = (await bob.me()).json();
    expect(me.twoFactor).toEqual({ enabled: false, enrollmentRequired: true });
    const blocked = await bob.req('GET', '/v1/admin/overview');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('2fa_required');
    expect(
      (await bob.req('POST', '/v1/admin/api-keys', { name: 'k', scopes: ['read'] })).statusCode,
    ).toBe(403);
    // can't turn it off once on, either
    const { secret } = await enrol(t, bob);
    expect((await bob.req('GET', '/v1/admin/overview')).statusCode).toBe(200);
    expect(
      (await bob.req('POST', '/v1/account/2fa/disable', { password: PASSWORD })).statusCode,
    ).toBe(403);
    expect((await login2fa(t, 'bob@example.com', codeAt(t, secret))).res.statusCode).toBe(200);
  });

  it('a lost phone: another user turns 2FA off for you; the admin token is never asked for a code', async () => {
    const off = await admin.req('POST', `/v1/admin/users/${bobId}/disable-2fa`, {
      stepUp: { password: PASSWORD, code: codeAt(t, adminSecret) },
    });
    expect(off.statusCode).toBe(200);
    const b = new Browser(t);
    const res = await b.login('bob@example.com');
    expect(res.json().mfaRequired).toBeUndefined();
    // still required: back to the enrolment screen
    expect((await b.me()).json().twoFactor.enrollmentRequired).toBe(true);
    const viaToken = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    expect(viaToken.statusCode).toBe(200);
  });
});

describe('THEIRSIDE_SECRET_KEY missing, wrong or rotated', () => {
  it('without a key 2FA cannot be turned on or required', async () => {
    const t = await startTestApp();
    try {
      const b = await setUp(t);
      const setup = await b.req('POST', '/v1/account/2fa/setup');
      expect(setup.statusCode).toBe(400);
      expect(setup.json().error).toBe('secret_key_missing');
      expect((await b.req('GET', '/v1/account/2fa')).json().available).toBe(false);
      const req = await b.req('PUT', '/v1/admin/settings/security', { require2fa: true });
      expect(req.json().error).toBe('secret_key_missing');
    } finally {
      await t.close();
    }
  });

  it('a lost key leaves recovery codes; a rotated key re-encrypts every secret', async () => {
    const db = await createTestDb();
    try {
      const a = await startTestApp({ db, env: { THEIRSIDE_SECRET_KEY: KEY_A } });
      const { secret, recoveryCodes } = await enrol(a, await setUp(a));
      const clock = a.clock;
      await a.close();

      // restarted without the key: codes can't be checked, recovery codes still work
      const none = await startTestApp({ db, clock });
      const r1 = await login2fa(none, 'ada@example.com', codeAt(none, secret));
      expect(r1.res.statusCode).toBe(503);
      expect(r1.res.json().error).toBe('secret_key_missing');
      expect((await login2fa(none, 'ada@example.com', recoveryCodes[0]!)).res.statusCode).toBe(200);
      await none.close();

      // new key with the old one as previous: rotate() re-encrypts at start
      const rot = await startTestApp({
        db,
        clock,
        env: { THEIRSIDE_SECRET_KEY: KEY_B, THEIRSIDE_SECRET_KEY_PREVIOUS: KEY_A },
      });
      expect(await rot.ctx.accounts.twoFactor.rotate()).toEqual({ rotated: 1, unreadable: 0 });
      expect(await rot.ctx.accounts.twoFactor.rotate()).toEqual({ rotated: 0, unreadable: 0 });
      await rot.close();

      // the old key can now be dropped
      const b = await startTestApp({ db, clock, env: { THEIRSIDE_SECRET_KEY: KEY_B } });
      clock.advance(30_000);
      expect((await login2fa(b, 'ada@example.com', codeAt(b, secret))).res.statusCode).toBe(200);
      await b.close();
    } finally {
      await db.drop();
    }
  });

  it('refuses a short key at startup', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', THEIRSIDE_SECRET_KEY: 'short' }),
    ).toThrow(/at least 32 characters/);
  });
});
