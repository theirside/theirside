import { gzipSync } from 'node:zlib';
import pg from 'pg';
import type { CallEvent, IngestBatch } from '@theirside/shared';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig, type CollectorConfig } from '../src/config.js';
import { createContext, type AppContext, type ContextOverrides } from '../src/context.js';
import { buildApp } from '../src/server.js';
import { migrate } from '../src/storage/migrate.js';
import { createPgStorage } from '../src/storage/postgres.js';
import type { Storage } from '../src/storage/types.js';
import { FakeClock } from '../src/util/clock.js';
import { randomBase62 } from '../src/util/ids.js';

/** Start it with: docker compose -f docker/docker-compose.test.yml up -d --wait */
export const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://theirside:im@127.0.0.1:54329/im';

export const TEST_API_KEY = 'tsd_live_testkey0000000000000000000000';
export const THEIRSIDE_ADMIN_TOKEN = 'admin-token-for-tests';

export interface TestDb {
  url: string;
  name: string;
  storage: Storage;
  pool: pg.Pool;
  drop(): Promise<void>;
}

/** A fresh, migrated database per test file. */
export async function createTestDb(): Promise<TestDb> {
  const name = `theirside_t_${randomBase62(10).toLowerCase()}`;
  const admin = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const { storage, pool } = createPgStorage({ connectionString: url.toString(), max: 20 });
  await migrate(pool);
  return {
    url: url.toString(),
    name,
    storage,
    pool,
    async drop() {
      await storage.close().catch(() => {});
      const a = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export function testConfig(dbUrl: string, env: Record<string, string> = {}): CollectorConfig {
  return loadConfig({
    DATABASE_URL: dbUrl,
    THEIRSIDE_BOOTSTRAP_API_KEY: TEST_API_KEY,
    THEIRSIDE_ADMIN_TOKEN,
    THEIRSIDE_SCHEDULER_ENABLED: 'false',
    ...env,
  });
}

export interface TestApp {
  db: TestDb;
  ctx: AppContext;
  app: Awaited<ReturnType<typeof buildApp>>;
  clock: FakeClock;
  orgId: string;
  projectId: string;
  close(): Promise<void>;
}

export async function startTestApp(
  opts: {
    env?: Record<string, string>;
    clock?: FakeClock;
    overrides?: ContextOverrides;
    db?: TestDb;
  } = {},
): Promise<TestApp> {
  const db = opts.db ?? (await createTestDb());
  const clock = opts.clock ?? new FakeClock(Date.now());
  const config = testConfig(db.url, opts.env);
  const ctx = createContext(config, db.storage, { clock, ...opts.overrides });
  const boot = await bootstrap(db.storage, {
    apiKey: config.bootstrapApiKey,
    orgName: config.bootstrapOrgName,
    projectName: config.bootstrapProjectName,
    entitlements: ctx.entitlements,
  });
  await db.storage.events.ensurePartitions(clock.now(), 4);
  const app = await buildApp(ctx);
  await app.ready();
  return {
    db,
    ctx,
    app,
    clock,
    orgId: boot.orgId!,
    projectId: boot.projectId!,
    async close() {
      await app.close();
      if (!opts.db) await db.drop();
    },
  };
}

export function event(overrides: Partial<CallEvent> = {}): CallEvent {
  return {
    ts: Date.now(),
    provider: 'Acme Cards',
    host: 'api.acmecards.test',
    method: 'POST',
    endpoint: '/v2/cards/:id/activate',
    status: 200,
    durationMs: 120,
    outcome: 'ok',
    ...overrides,
  };
}

export function batch(events: CallEvent[], overrides: Partial<IngestBatch> = {}): IngestBatch {
  return {
    protocol: 1,
    sdk: { name: '@theirside/sdk', version: '0.1.0' },
    service: 'payments-api',
    environment: 'production',
    dropped: 0,
    events,
    ...overrides,
  };
}

export function ingestRequest(body: unknown, key: string = TEST_API_KEY, gzip = true) {
  const json = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST' as const,
    url: '/v1/ingest',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    },
    payload: gzip ? gzipSync(json) : json,
  };
}
