import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Browser, invite, setUp } from './auth-helpers.js';
import { startTestApp, type TestApp } from './helpers.js';

const PROXY_IP = '10.0.5.17';
const OUTSIDER = '203.0.113.99';

/** A request as it arrives from `peer` (the TCP peer, not X-Forwarded-For). */
function from(
  t: TestApp,
  peer: string,
  headers: Record<string, string>,
  method = 'GET',
  url = '/v1/me',
) {
  return t.app.inject({ method: method as 'GET', url, remoteAddress: peer, headers });
}

describe('generic header (X-Forwarded-Email)', () => {
  let t: TestApp;
  let admin: Browser;
  beforeAll(async () => {
    t = await startTestApp({
      env: {
        THEIRSIDE_AUTH_PROXY: 'header',
        THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: '10.0.0.0/16, fd00::/8',
        THEIRSIDE_SECRET_KEY: 'test-secret-key-A-0123456789abcdefghij',
      },
    });
    admin = await setUp(t);
  });
  afterAll(async () => t.close());

  it('signs in an existing user when the header comes from a trusted proxy', async () => {
    const res = await from(t, PROXY_IP, { 'x-forwarded-email': 'ADA@example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ via: 'proxy', user: { email: 'ada@example.com' } });
    expect((await t.app.inject({ method: 'GET', url: '/v1/auth/status' })).json().proxy).toBe(
      'header',
    );
  });

  it('ignores the header from anyone else, whatever X-Forwarded-For says', async () => {
    for (const headers of <Record<string, string>[]>[
      { 'x-forwarded-email': 'ada@example.com' },
      { 'x-forwarded-email': 'ada@example.com', 'x-forwarded-for': PROXY_IP },
      {
        'x-forwarded-email': 'ada@example.com',
        'x-real-ip': PROXY_IP,
        forwarded: `for=${PROXY_IP}`,
      },
    ])
      expect((await from(t, OUTSIDER, headers)).statusCode).toBe(401);
    // the outsider's own session still decides who they are
    const eve = new Browser(t, OUTSIDER);
    await eve.login('ada@example.com');
    const res = await eve.req('GET', '/v1/me', undefined, {
      'x-forwarded-email': 'someone@example.com',
    });
    expect(res.json()).toMatchObject({ via: 'session', user: { email: 'ada@example.com' } });
  });

  it('trusts IPv6 ranges and IPv4-mapped peers', async () => {
    expect(
      (await from(t, 'fd00::1:2', { 'x-forwarded-email': 'ada@example.com' })).statusCode,
    ).toBe(200);
    expect(
      (await from(t, `::ffff:${PROXY_IP}`, { 'x-forwarded-email': 'ada@example.com' })).statusCode,
    ).toBe(200);
    expect(
      (await from(t, '::ffff:10.1.0.1', { 'x-forwarded-email': 'ada@example.com' })).statusCode,
    ).toBe(401);
  });

  it('refuses unknown people without an invite, and creates invited ones on first sign-in', async () => {
    const no = await from(t, PROXY_IP, { 'x-forwarded-email': 'stranger@example.com' });
    expect(no.statusCode).toBe(403);
    expect(no.json().error).toBe('no_account');
    await invite(admin, 'invited@example.com');
    const yes = await from(t, PROXY_IP, { 'x-forwarded-email': 'invited@example.com' });
    expect(yes.statusCode).toBe(200);
    const users = (await admin.req('GET', '/v1/admin/users')).json();
    expect(
      users.users.find((u: { email: string }) => u.email === 'invited@example.com'),
    ).toMatchObject({
      source: 'proxy',
      hasPassword: false,
    });
    expect(users.invites.map((i: { email: string }) => i.email)).not.toContain(
      'invited@example.com',
    );
  });

  it('rejects a header that is not an email', async () => {
    const res = await from(t, PROXY_IP, { 'x-forwarded-email': 'not an email' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_proxy_identity');
  });

  it('needs the CSRF token on writes like a cookie session (the proxy cookie is ambient)', async () => {
    const h = { 'x-forwarded-email': 'ada@example.com' };
    const create = (extra: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/admin/api-keys',
        remoteAddress: PROXY_IP,
        headers: { ...h, ...extra },
        payload: { name: 'k', scopes: ['read'] },
      });
    expect((await create({})).statusCode).toBe(403);
    const csrf = (await from(t, PROXY_IP, h)).json().csrfToken;
    expect(csrf).toEqual(expect.any(String));
    expect((await create({ 'x-csrf-token': csrf })).statusCode).toBe(201);
    expect(
      (await create({ 'x-csrf-token': csrf, origin: 'https://evil.example' })).statusCode,
    ).toBe(403);
  });

  it('proxy sign-ins are not asked for 2FA (the identity provider owns MFA)', async () => {
    await t.db.pool.query(`UPDATE orgs SET require_2fa = true`);
    const res = await from(
      t,
      PROXY_IP,
      { 'x-forwarded-email': 'invited@example.com' },
      'GET',
      '/v1/admin/overview',
    );
    expect(res.statusCode).toBe(200);
    await t.db.pool.query(`UPDATE orgs SET require_2fa = false`);
  });
});

describe('auto-create', () => {
  it('creates accounts on first sign-in, once even for concurrent requests, also before any org exists', async () => {
    const t = await startTestApp({
      env: {
        THEIRSIDE_BOOTSTRAP_API_KEY: '',
        THEIRSIDE_AUTH_PROXY: 'header',
        THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: PROXY_IP,
        THEIRSIDE_AUTH_PROXY_HEADER: 'X-Auth-Request-Email',
        THEIRSIDE_AUTH_PROXY_AUTO_CREATE: 'true',
      },
    });
    try {
      const h = { 'x-auth-request-email': 'first@example.com' };
      const all = await Promise.all(Array.from({ length: 5 }, () => from(t, PROXY_IP, h)));
      expect(all.filter((r) => r.statusCode === 200).length).toBeGreaterThanOrEqual(1);
      const ok = await from(t, PROXY_IP, h);
      expect(ok.json()).toMatchObject({ via: 'proxy', role: 'admin', user: { name: 'first' } });
      const { rows } = await t.db.pool.query(`SELECT count(*)::int AS n FROM users`);
      expect(rows[0].n).toBe(1);
      expect((await t.db.pool.query(`SELECT count(*)::int AS n FROM orgs`)).rows[0].n).toBe(1);
      // setup is done: the first proxy user counts
      expect(
        (await t.app.inject({ method: 'GET', url: '/v1/auth/status' })).json().setupRequired,
      ).toBe(false);
      const second = await from(t, PROXY_IP, { 'x-auth-request-email': 'second@example.com' });
      // the first user is the admin; later ones are members
      expect(second.json().role).toBe('member');
    } finally {
      await t.close();
    }
  });
});

describe('AWS ALB (x-amzn-oidc-data)', () => {
  const ARN =
    'arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/theirside/50dc6c495c0c9188';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const fetched: string[] = [];
  let t: TestApp;

  /** An ALB-style token: base64url segments with ALB's '=' padding, ES256 (P1363). */
  function albToken(o: { header?: object; payload?: object; key?: typeof privateKey } = {}) {
    const now = Math.floor(t.clock.now().getTime() / 1000);
    const seg = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64');
    const pad = (b64: string) => b64.replaceAll('+', '-').replaceAll('/', '_');
    const h = pad(
      seg({
        alg: 'ES256',
        kid: 'key-1',
        signer: ARN,
        iss: 'https://idp.example',
        client: 'c',
        exp: now + 120,
        ...o.header,
      }),
    );
    const p = pad(
      seg({
        sub: 'u1',
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        exp: now + 120,
        ...o.payload,
      }),
    );
    const sig = sign('sha256', Buffer.from(`${h}.${p}`), {
      key: o.key ?? privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return `${h}.${p}.${sig}`;
  }

  beforeAll(async () => {
    t = await startTestApp({
      env: {
        THEIRSIDE_AUTH_PROXY: 'alb',
        THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: '10.0.0.0/8',
        THEIRSIDE_AUTH_PROXY_ALB_ARN: ARN,
        THEIRSIDE_AUTH_PROXY_AUTO_CREATE: 'true',
      },
      overrides: {
        albKeyFetcher: async (url) => {
          fetched.push(url);
          if (!url.endsWith('/key-1')) throw new Error('HTTP 404');
          return publicKey.export({ type: 'spki', format: 'pem' }).toString();
        },
      },
    });
  });
  afterAll(async () => t.close());

  const alb = (token: string, peer = PROXY_IP) => from(t, peer, { 'x-amzn-oidc-data': token });

  it('verifies the signature with the key ALB publishes for the region, cached per key id', async () => {
    const res = await alb(albToken());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      via: 'proxy',
      user: { email: 'ada@example.com', name: 'Ada Lovelace' },
    });
    expect((await alb(albToken())).statusCode).toBe(200);
    expect(fetched).toEqual(['https://public-keys.auth.elb.eu-west-1.amazonaws.com/key-1']);
  });

  it.each([
    ['signed with another key', () => albToken({ key: other.privateKey })],
    [
      'from another load balancer',
      () => albToken({ header: { signer: ARN.replace('theirside', 'other') } }),
    ],
    [
      'expired',
      () => albToken({ header: { exp: Math.floor(t.clock.now().getTime() / 1000) - 120 } }),
    ],
    ['alg none', () => albToken({ header: { alg: 'none' } })],
    ['a key id that is a path', () => albToken({ header: { kid: '../../evil' } })],
    ['without an email', () => albToken({ payload: { email: undefined } })],
    [
      'tampered claims',
      () => {
        const [h, , s] = albToken().split('.');
        const p = Buffer.from(JSON.stringify({ email: 'mallory@example.com', exp: 9e9 })).toString(
          'base64url',
        );
        return `${h}.${p}.${s}`;
      },
    ],
    ['garbage', () => 'not.a.jwt'],
  ])('rejects a token %s', async (_n, make) => {
    const res = await alb(make());
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_proxy_identity');
  });

  it('a key that can not be fetched is a 503, retried next time', async () => {
    const res = await alb(albToken({ header: { kid: 'key-2' } }));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('proxy_key_unavailable');
    await alb(albToken({ header: { kid: 'key-2' } }));
    expect(fetched.filter((u) => u.endsWith('/key-2'))).toHaveLength(2);
  });

  it('ignores a valid token that did not come through the ALB', async () => {
    expect((await alb(albToken(), OUTSIDER)).statusCode).toBe(401);
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://x' };
  it.each([
    [{ THEIRSIDE_AUTH_PROXY: 'header' }, /TRUSTED_IPS is required/],
    [
      { THEIRSIDE_AUTH_PROXY: 'header', THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: '10.0.0.0/33' },
      /not an IP address or CIDR/,
    ],
    [
      { THEIRSIDE_AUTH_PROXY: 'header', THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: 'proxy.internal' },
      /not an IP address or CIDR/,
    ],
    [{ THEIRSIDE_AUTH_PROXY: 'alb', THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: '10.0.0.0/8' }, /ALB_ARN/],
    [{ THEIRSIDE_AUTH_PROXY: 'saml' }, /off, header or alb/],
  ])('refuses %o', (env, err) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(err);
  });

  it('is off by default', () => {
    expect(loadConfig(base).authProxy).toBeUndefined();
  });
});
