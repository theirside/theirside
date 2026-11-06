import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flush, init, shutdown, track } from '../src/index.js';
import { sleep, startCollector, type FakeCollector } from './helpers.js';

let collector: FakeCollector;
beforeAll(async () => {
  collector = await startCollector();
});
afterAll(async () => collector.close());
afterEach(async () => {
  await shutdown(200);
  collector.batches.length = 0;
});

function start(extra: Record<string, unknown> = {}, heartbeatMs = 100) {
  init(
    {
      apiKey: 'k',
      endpoint: collector.url,
      service: 'billing',
      environment: 'staging',
      remoteConfig: false,
      flushIntervalMs: 600_000,
      handleProcessExit: false,
      providers: [{ name: 'Acme', hosts: ['api.acme.test'] }],
      ...extra,
    },
    { heartbeatMs },
  );
}
const heartbeats = () => collector.batches.filter((b) => b.events.length === 0);

describe('SDK heartbeat', () => {
  it('an idle process sends an empty batch: service, version, instance, runtime, stats', async () => {
    start();
    await sleep(350);
    const hb = heartbeats();
    expect(hb.length).toBeGreaterThanOrEqual(1);
    expect(hb[0]).toMatchObject({
      service: 'billing',
      environment: 'staging',
      sdk: { name: '@theirside/sdk' },
      instance: { id: expect.stringMatching(/^[a-z0-9]{16}$/), startedAt: expect.any(Number) },
      runtime: { name: 'node', version: process.versions.node, serverless: false },
      stats: { queued: 0, sent: 0, failedFlushes: 0 },
      events: [],
    });
    // nothing about calls, and nothing else
    expect(Object.keys(hb[0]!).sort()).toEqual(
      [
        'dropped',
        'environment',
        'events',
        'instance',
        'protocol',
        'runtime',
        'sdk',
        'service',
        'stats',
      ].sort(),
    );
  });

  it('none while calls are being sent; every batch carries the same instance', async () => {
    start({}, 300);
    for (let i = 0; i < 4; i++) {
      track({ url: 'https://api.acme.test/v1/x', durationMs: 3, status: 200 });
      await flush();
      await sleep(80);
    }
    expect(heartbeats()).toHaveLength(0);
    const ids = new Set(collector.batches.map((b) => b.instance?.id));
    expect(ids.size).toBe(1);
  });

  it('none in serverless mode (the process is frozen between invocations)', async () => {
    start({ serverless: true });
    await sleep(350);
    expect(heartbeats()).toHaveLength(0);
  });
});
