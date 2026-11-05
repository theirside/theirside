import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIVATE_PROXY_RANGES, loadConfig } from '../src/config.js';
import { createTestDb, startTestApp, type TestApp, type TestDb } from './helpers.js';

/** The client IP the collector used: the address its failed sign-in was counted against. */
async function seenIp(t: TestApp, peer: string, forwardedFor?: string): Promise<string> {
  await t.db.pool.query(`DELETE FROM auth_throttle`);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress: peer,
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    payload: { email: 'nobody@example.com', password: 'not the password' },
  });
  expect(res.statusCode).toBe(401);
  const { rows } = await t.db.pool.query(`SELECT key FROM auth_throttle WHERE key LIKE 'ip:%'`);
  return (rows[0].key as string).slice(3);
}

describe('THEIRSIDE_TRUST_PROXY', () => {
  let db: TestDb;
  const apps: TestApp[] = [];
  const app = async (env: Record<string, string> = {}) => {
    const t = await startTestApp({ db, env });
    apps.push(t);
    return t;
  };
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    for (const t of apps) await t.close();
    await db.drop();
  });

  it('parses the setting', () => {
    const cfg = (v?: string) =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        ...(v === undefined ? {} : { THEIRSIDE_TRUST_PROXY: v }),
      }).trustProxy;
    expect(cfg()).toEqual(PRIVATE_PROXY_RANGES);
    expect(cfg('')).toEqual(PRIVATE_PROXY_RANGES);
    expect(cfg('true')).toBe(true);
    expect(cfg('false')).toBe(false);
    expect(cfg('0')).toBe(false);
    expect(cfg('1')).toBe(1);
    expect(cfg('2')).toBe(2);
    expect(cfg('10.0.0.0/24, 10.0.1.0/24')).toEqual(['10.0.0.0/24', '10.0.1.0/24']);
  });

  it('by default believes X-Forwarded-For only from private and loopback addresses', async () => {
    const t = await app();
    for (const peer of ['10.1.2.3', '172.20.0.4', '192.168.1.5', '127.0.0.1', '::1', 'fd00::5'])
      expect(await seenIp(t, peer, '198.51.100.20')).toBe('198.51.100.20');
    // IPv4-mapped peers (dual-stack sockets) count as their IPv4 address
    expect(await seenIp(t, '::ffff:10.0.0.9', '198.51.100.21')).toBe('198.51.100.21');
    // a client on the internet can't choose the address its attempts count against
    expect(await seenIp(t, '203.0.113.7', '198.51.100.22')).toBe('203.0.113.7');
    expect(await seenIp(t, '172.32.0.1', '198.51.100.23')).toBe('172.32.0.1');
    expect(await seenIp(t, '2001:db8::1', '198.51.100.24')).toBe('2001:db8::1');
  });

  it('explicit CIDRs replace the private ranges', async () => {
    const t = await app({ THEIRSIDE_TRUST_PROXY: '10.0.12.0/24' });
    expect(await seenIp(t, '10.0.12.8', '198.51.100.30')).toBe('198.51.100.30');
    expect(await seenIp(t, '10.0.13.8', '198.51.100.31')).toBe('10.0.13.8');
    expect(await seenIp(t, '127.0.0.1', '198.51.100.32')).toBe('127.0.0.1');
  });

  it('true believes any address; false none', async () => {
    const all = await app({ THEIRSIDE_TRUST_PROXY: 'true' });
    expect(await seenIp(all, '203.0.113.7', '198.51.100.40')).toBe('198.51.100.40');
    const none = await app({ THEIRSIDE_TRUST_PROXY: 'false' });
    expect(await seenIp(none, '10.0.0.1', '198.51.100.41')).toBe('10.0.0.1');
  });
});
