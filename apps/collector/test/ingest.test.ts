import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { LATENCY_BUCKET_COUNT, bucketIndex } from '@theirside/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/modules/auth/api-keys.js';
import { prepareBatch } from '../src/modules/ingest/prepare.js';
import {
  batch,
  event,
  ingestRequest,
  startTestApp,
  TEST_API_KEY,
  type TestApp,
} from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.close();
});

const count = async (sql: string, params: unknown[] = []) =>
  Number((await t.db.pool.query(sql, params)).rows[0]?.n ?? 0);

describe('POST /v1/ingest', () => {
  it('stores raw events, rollups, usage, SDK heartbeat and providers in one go', async () => {
    const now = t.clock.now().getTime();
    const minute = now - (now % 60_000);
    const res = await t.app.inject(
      ingestRequest(
        batch(
          [
            event({ ts: minute + 1000, durationMs: 100 }),
            event({ ts: minute + 2000, durationMs: 3000, status: 503, outcome: 'http_5xx' }),
            event({
              ts: minute + 3000,
              durationMs: 50,
              status: 429,
              outcome: 'http_4xx',
              providerRequestId: 'req_1',
            }),
            event({
              ts: minute + 4000,
              durationMs: 10,
              status: null,
              outcome: 'timeout',
              errorCode: 'ETIMEDOUT',
            }),
            event({
              ts: minute + 5000,
              endpoint: '/v1/kyc/checks',
              provider: 'KYCo',
              host: 'kyc.test',
            }),
          ],
          { dropped: 7, lastFlushError: 'http_503' },
        ),
      ),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 5 });

    expect(await count('SELECT count(*) AS n FROM events')).toBe(5);
    const { rows } = await t.db.pool.query(
      `SELECT * FROM rollups_1m WHERE endpoint = '/v2/cards/:id/activate'`,
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({
      org_id: t.orgId,
      project_id: t.projectId,
      environment: 'production',
      provider: 'Acme Cards',
      method: 'POST',
      total: 4,
      ok: 1,
      http_4xx: 1,
      http_5xx: 1,
      timeout: 1,
      status_429: 1,
    });
    expect(new Date(r.minute).getTime()).toBe(minute);
    expect(Number(r.latency_sum_ms)).toBeCloseTo(3160);
    expect(r[`h${bucketIndex(3000)}`]).toBe(1);

    const usage = (await t.db.pool.query('SELECT * FROM usage_daily')).rows[0];
    expect(usage).toMatchObject({ calls_ingested: 5, events_dropped_reported: 7 });
    const sdk = (await t.db.pool.query('SELECT * FROM sdk_instances')).rows[0];
    expect(sdk).toMatchObject({
      service: 'payments-api',
      environment: 'production',
      sdk_version: '0.1.0',
      dropped_events: 7,
      last_flush_error: 'http_503',
    });
    const providers = (
      await t.db.pool.query('SELECT name, host_patterns FROM providers ORDER BY name')
    ).rows;
    expect(providers).toEqual([
      { name: 'Acme Cards', host_patterns: ['api.acmecards.test'] },
      { name: 'KYCo', host_patterns: ['kyc.test'] },
    ]);
  });

  it('adds to existing rollup rows on later batches', async () => {
    const ts = t.clock.now().getTime() - 120_000;
    for (let i = 0; i < 3; i++) {
      const res = await t.app.inject(ingestRequest(batch([event({ ts, endpoint: '/v1/merge' })])));
      expect(res.statusCode).toBe(202);
    }
    expect(await count(`SELECT total AS n FROM rollups_1m WHERE endpoint = '/v1/merge'`)).toBe(3);
  });

  it('accepts uncompressed JSON too', async () => {
    const res = await t.app.inject(ingestRequest(batch([event()]), TEST_API_KEY, false));
    expect(res.statusCode).toBe(202);
  });

  it('ignores unknown fields (forward compatible)', async () => {
    const res = await t.app.inject(
      ingestRequest({ ...batch([{ ...event(), futureField: 1 } as never]), alsoNew: { x: 1 } }),
    );
    expect(res.statusCode).toBe(202);
  });

  it.each([
    ['no key', undefined],
    ['wrong key', 'tsd_live_doesnotexist000000000000'],
    ['malformed key', 'nope'],
  ])('401 with %s', async (_n, key) => {
    const req = ingestRequest(batch([event()]));
    if (key === undefined) delete (req.headers as Record<string, string>).authorization;
    else req.headers.authorization = `Bearer ${key}`;
    expect((await t.app.inject(req)).statusCode).toBe(401);
  });

  it('401 for a key without the ingest scope, and for a revoked key', async () => {
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const { key: readKey } = await createApiKey(t.db.storage.config, tenant, 'read only', ['read']);
    expect((await t.app.inject(ingestRequest(batch([event()]), readKey))).statusCode).toBe(401);

    const { key, record } = await createApiKey(t.db.storage.config, tenant, 'to revoke', [
      'ingest',
    ]);
    expect((await t.app.inject(ingestRequest(batch([event()]), key))).statusCode).toBe(202);
    await t.db.storage.config.revokeApiKey(tenant, record.id);
    t.ctx.apiKeys.invalidate();
    expect((await t.app.inject(ingestRequest(batch([event()]), key))).statusCode).toBe(401);
  });

  it.each([
    ['invalid outcome', batch([event({ outcome: 'weird' as never })])],
    ['future protocol', { ...batch([event()]), protocol: 99 }],
    ['missing events', { ...batch([]), events: undefined }],
    ['not JSON', 'not json at all'],
  ])('400 for %s', async (_n, body) => {
    const req =
      typeof body === 'string'
        ? { ...ingestRequest({}), payload: gzipSync(Buffer.from(body)) }
        : ingestRequest(body);
    expect((await t.app.inject(req)).statusCode).toBe(400);
  });

  it('413 for more than 5000 events', async () => {
    const res = await t.app.inject(ingestRequest(batch(new Array(5001).fill(event()))));
    expect(res.statusCode).toBe(413);
  });

  it('413 for a body over 1 MB compressed', async () => {
    const req = ingestRequest(batch([event()]));
    req.payload = randomBytes(1024 * 1024 + 10); // incompressible
    expect((await t.app.inject(req)).statusCode).toBe(413);
  });

  it('413 for a gzip bomb', async () => {
    const req = ingestRequest(batch([event()]));
    req.payload = gzipSync(Buffer.alloc(40 * 1024 * 1024, 32)); // 40 MB of spaces, ~40 KB gzipped
    expect((await t.app.inject(req)).statusCode).toBe(413);
  });

  it('stores nothing from a rejected batch', async () => {
    const before = await count('SELECT count(*) AS n FROM events');
    await t.app.inject(ingestRequest(batch([event(), event({ status: 'x' as never })])));
    expect(await count('SELECT count(*) AS n FROM events')).toBe(before);
  });
});

describe('prepareBatch', () => {
  const recv = new Date('2026-11-03T10:00:30.000Z');

  it('weights sampled successes in rollups only', () => {
    const p = prepareBatch(
      batch(
        [
          event({ ts: recv.getTime() }),
          event({ ts: recv.getTime(), outcome: 'http_5xx', status: 500 }),
        ],
        {
          sampleRate: 0.1,
        },
      ) as never,
      recv,
    );
    expect(p.events).toHaveLength(2);
    expect(p.deltas[0]).toMatchObject({ total: 11, ok: 10 });
    expect(p.deltas[0]!.outcomes.http_5xx).toBe(1);
    expect(p.calls).toBe(11);
    expect(p.deltas[0]!.latencyHistogram).toHaveLength(LATENCY_BUCKET_COUNT);
  });

  it.each([
    ['far future', recv.getTime() + 3600_000, recv.getTime()],
    ['far past', recv.getTime() - 3 * 86_400_000, recv.getTime()],
    ['slightly behind', recv.getTime() - 60_000, recv.getTime() - 60_000],
  ])('clamps implausible clocks: %s', (_n, ts, expected) => {
    const p = prepareBatch(batch([event({ ts })]) as never, recv);
    expect(p.events[0]!.ts.getTime()).toBe(expected);
  });

  it('fills service/environment/sdkVersion from the batch header', () => {
    const p = prepareBatch(
      batch([event()], { service: 'svc', environment: 'staging' }) as never,
      recv,
    );
    expect(p.events[0]).toMatchObject({
      service: 'svc',
      environment: 'staging',
      sdkVersion: '0.1.0',
    });
    expect(p.deltas[0]!.environment).toBe('staging');
  });

  it('groups by environment, provider, endpoint, method and minute', () => {
    const base = recv.getTime();
    const p = prepareBatch(
      batch([
        event({ ts: base }),
        event({ ts: base + 1 }),
        event({ ts: base, method: 'get' }),
        event({ ts: base + 60_000 }),
        event({ ts: base, environment: 'staging' }),
      ]) as never,
      recv,
    );
    expect(
      p.deltas.map((d) => `${d.environment} ${d.method} ${d.minute} ${d.total}`).sort(),
    ).toEqual([
      'production GET 2026-11-03T10:00:00.000Z 1',
      'production POST 2026-11-03T10:00:00.000Z 2',
      'production POST 2026-11-03T10:01:00.000Z 1',
      'staging POST 2026-11-03T10:00:00.000Z 1',
    ]);
  });
});
