import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_LICENSE_PRIVATE_KEY } from '../src/modules/entitlements/dev-keys.js';
import {
  LicenseEntitlementsResolver,
  signLicense,
  type LicensePayload,
} from '../src/modules/entitlements/license.js';
import { OSS_ENTITLEMENTS } from '../src/modules/entitlements/types.js';
import { createStatusPage, StatusPageLimitError } from '../src/modules/status-page/create.js';
import { FakeClock } from '../src/util/clock.js';
import { batch, createTestDb, event, ingestRequest, startTestApp, type TestDb } from './helpers.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const clock = new FakeClock(NOW);

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    iss: 'theirside',
    sub: 'Example Co',
    plan: 'business',
    iat: NOW.getTime() / 1000 - 60,
    exp: NOW.getTime() / 1000 + 30 * 86400,
    ent: {
      networkView: true,
      slaReports: true,
      sso: true,
      retentionDays: 365,
      pagingIntegrations: true,
    },
    ...overrides,
  };
}

const resolver = (licenseKey: string | undefined, allowDevLicense = true) =>
  new LicenseEntitlementsResolver({ licenseKey, allowDevLicense, clock });

describe('licence entitlements', () => {
  it('defaults to OSS without a licence', async () => {
    expect(await resolver(undefined).for('org_1')).toEqual(OSS_ENTITLEMENTS);
  });

  it('upgrades with a valid licence', async () => {
    const e = await resolver(signLicense(payload(), DEV_LICENSE_PRIVATE_KEY)).for('org_1');
    expect(e).toMatchObject({
      plan: 'business',
      source: 'license',
      networkView: true,
      slaReports: true,
      sso: true,
      retentionDays: 365,
      pagingIntegrations: true,
      customStatusDomain: false,
      monthlyCallLimit: null,
      licensee: 'Example Co',
    });
  });

  it.each([
    [
      'expired',
      () => signLicense(payload({ exp: NOW.getTime() / 1000 - 1 }), DEV_LICENSE_PRIVATE_KEY),
    ],
    [
      'issued in the future',
      () => signLicense(payload({ iat: NOW.getTime() / 1000 + 3600 }), DEV_LICENSE_PRIVATE_KEY),
    ],
    ['wrong issuer', () => signLicense(payload({ iss: 'someone-else' }), DEV_LICENSE_PRIVATE_KEY)],
    [
      'signed by another key',
      () => {
        const { privateKey } = generateKeyPairSync('ed25519');
        return signLicense(
          payload(),
          privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        );
      },
    ],
    [
      'tampered payload',
      () => {
        const [h, , s] = signLicense(payload(), DEV_LICENSE_PRIVATE_KEY).split('.');
        const forged = Buffer.from(
          JSON.stringify(payload({ ent: { monthlyCallLimit: null, sso: true } })),
        ).toString('base64url');
        return `${h}.${forged}.${s}`;
      },
    ],
    ['garbage', () => 'not-a-licence'],
  ])('falls back to OSS when %s', async (_n, make) => {
    expect(await resolver(make()).for('org_1')).toEqual(OSS_ENTITLEMENTS);
  });

  it('rejects dev-signed licences unless THEIRSIDE_ALLOW_DEV_LICENSE is on', async () => {
    const lic = signLicense(payload(), DEV_LICENSE_PRIVATE_KEY);
    expect((await resolver(lic, false).for('org_1')).source).toBe('oss');
    expect((await resolver(lic, true).for('org_1')).source).toBe('license');
  });

  it('degrades to OSS when the licence expires while running', async () => {
    const c = new FakeClock(NOW);
    const r = new LicenseEntitlementsResolver({
      licenseKey: signLicense(payload({ exp: NOW.getTime() / 1000 + 60 }), DEV_LICENSE_PRIVATE_KEY),
      allowDevLicense: true,
      clock: c,
    });
    expect((await r.for('o')).source).toBe('license');
    c.advance(61_000);
    expect((await r.for('o')).source).toBe('oss');
  });

  it('OSS editions: one org, one status page, no paid flags', () => {
    expect(OSS_ENTITLEMENTS).toMatchObject({
      maxOrgs: 1,
      maxStatusPages: 1,
      rbac: false,
      auditLog: false,
      whiteLabelStatusPage: false,
      slaReports: false,
      networkView: false,
      sso: false,
      customStatusDomain: false,
      pagingIntegrations: false,
    });
  });

  it('a licence can set the edition flags', async () => {
    const e = await resolver(
      signLicense(
        payload({
          ent: {
            rbac: true,
            auditLog: true,
            maxOrgs: null,
            maxStatusPages: 5,
            whiteLabelStatusPage: true,
          },
        }),
        DEV_LICENSE_PRIVATE_KEY,
      ),
    ).for('o');
    expect(e).toMatchObject({
      rbac: true,
      auditLog: true,
      maxOrgs: null,
      maxStatusPages: 5,
      whiteLabelStatusPage: true,
    });
  });

  it('ignores unknown or mistyped entitlement fields', async () => {
    const e = await resolver(
      signLicense(
        payload({ ent: { sso: 'yes', maxProjects: -5, unknown: true } as never }),
        DEV_LICENSE_PRIVATE_KEY,
      ),
    ).for('o');
    expect(e.sso).toBe(false);
    expect(e.maxProjects).toBeNull();
    expect(e).not.toHaveProperty('unknown');
  });
});

describe('licence and limits at ingest', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('an expired licence never stops ingest', async () => {
    const expired = signLicense(
      payload({ exp: NOW.getTime() / 1000 - 10 }),
      DEV_LICENSE_PRIVATE_KEY,
    );
    const t = await startTestApp({
      db,
      clock: new FakeClock(NOW),
      env: { THEIRSIDE_LICENSE_KEY: expired, THEIRSIDE_ALLOW_DEV_LICENSE: '1' },
    });
    const res = await t.app.inject(ingestRequest(batch([event({ ts: NOW.getTime() })])));
    expect(res.statusCode).toBe(202);
    await t.close();
  });

  it('enforces monthlyCallLimit only when an entitlement sets one (429)', async () => {
    const limited = signLicense(
      payload({ ent: { monthlyCallLimit: 10 } }),
      DEV_LICENSE_PRIVATE_KEY,
    );
    const t = await startTestApp({
      db,
      clock: new FakeClock(NOW),
      env: { THEIRSIDE_LICENSE_KEY: limited, THEIRSIDE_ALLOW_DEV_LICENSE: '1' },
    });
    const five = () => batch(Array.from({ length: 5 }, () => event({ ts: NOW.getTime() })));
    expect((await t.app.inject(ingestRequest(five()))).statusCode).toBe(202);
    // earlier test in this db ingested 1 call this month: 1 + 5 + 5 > 10
    const res = await t.app.inject(ingestRequest(five()));
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    await t.close();
  });
});

describe('status page entitlements', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  const page = (title: string) => ({
    publicToken: `tok_${title}_000000000000`,
    title,
    providerFilter: [],
    theme: 'auto' as const,
  });

  it('OSS allows one status page per org (the bootstrap one)', async () => {
    const t = await startTestApp({ db, clock: new FakeClock(NOW) });
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    expect(await db.storage.config.countStatusPages(t.orgId)).toBe(1);
    await expect(
      createStatusPage(db.storage.config, await t.ctx.entitlements.for(t.orgId), tenant, page('a')),
    ).rejects.toBeInstanceOf(StatusPageLimitError);
    await t.close();
  });

  it('maxStatusPages from a licence raises the limit', async () => {
    const lic = signLicense(payload({ ent: { maxStatusPages: 2 } }), DEV_LICENSE_PRIVATE_KEY);
    const t = await startTestApp({
      db,
      clock: new FakeClock(NOW),
      env: { THEIRSIDE_LICENSE_KEY: lic, THEIRSIDE_ALLOW_DEV_LICENSE: '1' },
    });
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const ent = await t.ctx.entitlements.for(t.orgId);
    await createStatusPage(db.storage.config, ent, tenant, page('b'));
    await expect(createStatusPage(db.storage.config, ent, tenant, page('c'))).rejects.toThrow(
      /limit reached \(2\)/,
    );
    await t.close();
  });

  it('shows "Powered by" unless whiteLabelStatusPage', async () => {
    const free = await startTestApp({ db, clock: new FakeClock(NOW) });
    const token = (
      await db.storage.config.listStatusPages({ orgId: free.orgId, projectId: free.projectId })
    )[0]!.publicToken;
    const get = (t: typeof free) => t.app.inject({ method: 'GET', url: `/status/${token}` });
    expect((await get(free)).body).toContain('Powered by');
    await free.close();

    const lic = signLicense(
      payload({ ent: { whiteLabelStatusPage: true } }),
      DEV_LICENSE_PRIVATE_KEY,
    );
    const paid = await startTestApp({
      db,
      clock: new FakeClock(NOW),
      env: { THEIRSIDE_LICENSE_KEY: lic, THEIRSIDE_ALLOW_DEV_LICENSE: '1' },
    });
    const res = await get(paid);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Powered by');
    await paid.close();
  });
});
