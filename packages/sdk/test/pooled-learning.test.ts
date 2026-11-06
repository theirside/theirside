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
  collector.configRequests.length = 0;
  collector.sdkConfig = undefined;
});

const base = { hidden: [], internal: [], providers: [], tenants: [], sampleRate: null };

async function start() {
  init(
    {
      apiKey: 'k',
      endpoint: collector.url,
      service: 'card-fn',
      environment: 'staging',
      flushIntervalMs: 600_000,
      handleProcessExit: false,
    },
    { remoteConfigIntervalMs: 60_000 },
  );
  // the first remote config fetch runs right after init, in the background
  for (let i = 0; i < 50 && collector.configRequests.length === 0; i++) await sleep(10);
  await sleep(30);
}
const call = (path: string) =>
  track({ url: `https://api.acme.test${path}`, durationMs: 4, status: 200 });

describe('pooled learning (remote config, per service)', () => {
  it('asks for its service and environment', async () => {
    await start();
    expect(collector.configRequests[0]!.url).toBe(
      '/v1/sdk-config?service=card-fn&environment=staging',
    );
  });

  it('a cold start applies positions the service learned together', async () => {
    collector.sdkConfig = {
      ...base,
      learned: [{ provider: 'acme.test', hosts: ['api.acme.test'], parent: '/v1', position: 1 }],
    };
    await start();
    call('/v1/accounts'); // a vocabulary word: sent as-is by a fresh process on its own
    call('/v1/accounts/payments');
    await flush();
    expect(collector.events().map((e) => e.endpoint)).toEqual(['/v1/:id', '/v1/:id/payments']);
  });

  it('without pooled learning the same fresh process sends the word', async () => {
    collector.sdkConfig = base;
    await start();
    call('/v1/accounts');
    await flush();
    expect(collector.events().map((e) => e.endpoint)).toEqual(['/v1/accounts']);
  });

  it('ignores malformed entries', async () => {
    collector.sdkConfig = {
      ...base,
      learned: [
        { provider: 'acme.test', hosts: ['api.acme.test'], parent: '/v1', position: -1 },
        { provider: 'acme.test', parent: '/v1', position: 'x' },
        null,
      ],
    };
    await start();
    call('/v1/accounts');
    await flush();
    expect(collector.events().map((e) => e.endpoint)).toEqual(['/v1/accounts']);
  });
});
