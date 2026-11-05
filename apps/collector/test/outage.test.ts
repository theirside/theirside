import http from 'node:http';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { getStats, init, shutdown } from '@theirside/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { createContext } from '../src/context.js';
import { buildApp } from '../src/server.js';
import { createPgStorage } from '../src/storage/postgres.js';
import { systemClock } from '../src/util/clock.js';
import {
  ADMIN_DATABASE_URL,
  TEST_API_KEY,
  createTestDb,
  testConfig,
  type TestDb,
} from './helpers.js';

/** TCP proxy in front of Postgres that the test can cut and restore. */
async function startProxy(target: { host: string; port: number }) {
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  let port = 0;
  const up = () =>
    new Promise<void>((resolve) => {
      server = net.createServer((client) => {
        const upstream = net.connect(target.port, target.host);
        sockets.add(client).add(upstream);
        client.pipe(upstream).pipe(client);
        const kill = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on('error', kill).on('close', kill);
        upstream.on('error', kill).on('close', kill);
      });
      server.listen(port, '127.0.0.1', () => {
        port = (server!.address() as net.AddressInfo).port;
        resolve();
      });
    });
  const down = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server?.close(() => resolve());
    });
  await up();
  return { port: () => port, up, down };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe('connection loss', () => {
  it('does not crash when a checked-out or idle connection dies (Postgres restart)', async () => {
    const pgUrl = new URL(ADMIN_DATABASE_URL);
    const proxy = await startProxy({ host: pgUrl.hostname, port: Number(pgUrl.port) });
    const url = new URL(db.url);
    url.hostname = '127.0.0.1'; // the proxy, wherever Postgres itself is
    url.port = String(proxy.port());
    const { storage, pool } = createPgStorage({
      connectionString: url.toString(),
      connectionTimeoutMillis: 500,
    });
    await storage.ping(); // one idle client
    const held = await pool.connect(); // one checked-out client
    await proxy.down();
    await sleep(300); // 'error' events fire on both clients here
    held.release(true);
    await expect(storage.ping()).rejects.toThrow();
    await proxy.up();
    await expect(storage.ping()).resolves.toBeUndefined();
    await storage.close();
    await proxy.down();
  });
});

describe('Postgres outage under load', () => {
  it('collector returns 503, the SDK backs off, the app does not notice, and data resumes', async () => {
    const pgUrl = new URL(ADMIN_DATABASE_URL);
    const proxy = await startProxy({ host: pgUrl.hostname, port: Number(pgUrl.port) });
    const proxiedUrl = new URL(db.url);
    proxiedUrl.hostname = '127.0.0.1';
    proxiedUrl.port = String(proxy.port());

    const { storage } = createPgStorage({
      connectionString: proxiedUrl.toString(),
      connectionTimeoutMillis: 1000,
    });
    const config = testConfig(proxiedUrl.toString());
    const ctx = createContext(config, storage, { clock: systemClock });
    await bootstrap(storage, {
      apiKey: TEST_API_KEY,
      orgName: 'o',
      projectName: 'p',
      entitlements: ctx.entitlements,
    });
    await storage.events.ensurePartitions(new Date(), 2);
    const app = await buildApp(ctx);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const collectorUrl = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;

    // the "demo app": calls a provider continuously through the SDK
    const provider = http.createServer((req, res) => {
      req.resume();
      res.end('ok');
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
    const providerPort = (provider.address() as net.AddressInfo).port;
    init({
      apiKey: TEST_API_KEY,
      endpoint: collectorUrl,
      service: 'outage-test',
      flushIntervalMs: 100,
      providers: [{ name: 'Local', hosts: ['localhost'] }],
      handleProcessExit: false,
    });

    const latencies: number[] = [];
    let appErrors = 0;
    let calls = 0;
    let stop = false;
    const traffic = (async () => {
      while (!stop) {
        const t0 = performance.now();
        await new Promise<void>((resolve) => {
          http
            .get(`http://localhost:${providerPort}/v1/x/${calls}`, (res) => {
              res.resume();
              res.on('end', resolve);
            })
            .on('error', () => {
              appErrors++;
              resolve();
            });
        });
        latencies.push(performance.now() - t0);
        calls++;
        await sleep(5);
      }
    })();

    const statuses: number[] = [];
    const probe = async () => {
      const res = await fetch(`${collectorUrl}/v1/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: 1,
          sdk: { name: 'x', version: '1' },
          service: 's',
          environment: 'e',
          dropped: 0,
          events: [],
        }),
      });
      statuses.push(res.status);
    };

    await sleep(1000);
    expect(getStats()?.sent).toBeGreaterThan(0);
    expect(getStats()?.lastFlushError).toBeUndefined();

    await proxy.down(); // kill Postgres mid-load
    await sleep(1500);
    await probe();
    expect(statuses).toEqual([503]);
    const during = getStats()!;
    expect(during.lastFlushError).toBe('http_503');
    expect(during.failedFlushes).toBeGreaterThanOrEqual(1);
    const failedAfterOutage = during.failedFlushes;
    await sleep(1500);
    // backing off: far fewer attempts than one per 100 ms flush interval
    expect(getStats()!.failedFlushes - failedAfterOutage).toBeLessThanOrEqual(2);

    await proxy.up(); // Postgres back
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && getStats()?.lastFlushError) await sleep(200);
    stop = true;
    await traffic;
    await shutdown(2000);

    const s = getStats();
    expect(s).toBeUndefined(); // shut down
    const stored = Number(
      (await db.pool.query(`SELECT count(*)::int AS n FROM events WHERE provider = 'Local'`))
        .rows[0].n,
    );
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)]!;

    expect(appErrors).toBe(0);
    expect(p99).toBeLessThan(25);
    // nothing lost: the queue held the outage's events and the retry batch went through
    expect(stored).toBe(calls);

    await app.close();
    await storage.close();
    await proxy.down();
    provider.close();
  }, 40_000);
});
