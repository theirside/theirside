import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flush, getStats, init, shutdown, wrap, type InitOptions } from '../src/index.js';
import { albEvent } from './fixtures/lambda-events.js';
import { sleep, startCollector, type FakeCollector } from './helpers.js';

/**
 * AWS Lambda freezes the process as soon as the handler's promise settles, so a
 * webhook delivery must be sent before the wrapped handler returns: no timer
 * runs afterwards. These tests check the requests at exactly that moment.
 *
 * The delivery's status comes from the handler's result, so it is recorded only
 * after the handler returns: a flush inside the handler (an app's own `finally`)
 * can't include it, and `wrap()` must send it even with `flushTimeoutMs: 0`.
 */
let collector: FakeCollector;
beforeAll(async () => {
  collector = await startCollector();
});
afterAll(async () => collector.close());
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown(300);
  collector.batches.length = 0;
  collector.batchPaths.length = 0;
  collector.requests.length = 0;
  collector.configRequests.length = 0;
  collector.sdkConfig = undefined;
  collector.noInboundRoute = false;
  collector.configDelayMs = 0;
  collector.status = 202;
});

const INBOUND_CONFIG = {
  hidden: [],
  internal: [],
  providers: [],
  tenants: [],
  sampleRate: null,
  inbound: true,
};

/** A CloudEvents delivery to a custom route on a webhook host, from a sender the SDK can't identify. */
const cloudEvent = (path = '/v1/notifyco', source = 'https://api.notifyco.test/events') =>
  albEvent(path, {
    host: 'webhook.ours.test',
    'user-agent': 'NotifyCo-Webhooks/2.1',
    'ce-specversion': '1.0',
    'ce-source': source,
    'ce-type': 'test.notifyco.message.delivered',
    'ce-id': '6c0f1b9e-7a51-4d1e-9a3c-1f2e3d4c5b6a',
    'ce-time': new Date().toISOString(),
    'x-hmac-signature-sha-256': 'ZmFrZS1zaWduYXR1cmU=',
  });

const context = (left = 5000) => ({ getRemainingTimeInMillis: () => left });

function start(extra: Partial<InitOptions> = {}) {
  init({
    apiKey: 'k',
    endpoint: collector.url,
    service: 'webhooks-fn',
    serverless: true,
    flushIntervalMs: 600_000, // no periodic flush: a frozen process runs no timers
    remoteConfig: true,
    inbound: true,
    autoDiscover: false,
    ...extra,
  });
}

/** The app's handler: its own `finally` flushes, capped at 300 ms and the deadline − 500 ms. */
const appHandler = async (_e: unknown, ctx: { getRemainingTimeInMillis(): number }) => {
  try {
    await sleep(20); // the app's work
    return { statusCode: 200, body: '{"ok":true}' };
  } finally {
    await flush(Math.min(300, ctx.getRemainingTimeInMillis() - 500));
  }
};

const inboundPosts = () => collector.batchPaths.filter((p) => p === '/v1/ingest/inbound');
const candidates = () => collector.events().filter((e) => e.direction === 'inbound');

describe('Lambda: a webhook delivery leaves before the invocation returns', () => {
  it("cold start, remote config not answered yet: the app's own flush + flushTimeoutMs: 0", async () => {
    collector.configDelayMs = -1; // still pending for the whole invocation
    start();
    const handler = wrap(appHandler, { flushTimeoutMs: 0 });
    await handler(cloudEvent(), context());
    // the process is frozen now: whatever was not sent yet is not sent
    expect(inboundPosts()).toEqual(['/v1/ingest/inbound']);
    expect(candidates()).toEqual([
      expect.objectContaining({
        candidate: true,
        count: 1,
        provider: 'notifyco',
        method: 'POST',
        endpoint: '/v1/notifyco',
        status: 200,
        direction: 'inbound',
      }),
    ]);
  });

  it('remote config answered during the handler: the delivery goes the usual path, still in time', async () => {
    collector.sdkConfig = INBOUND_CONFIG;
    start();
    const handler = wrap(
      async (e: unknown, ctx: { getRemainingTimeInMillis(): number }) => {
        // the config answer arrives while the handler runs
        const deadline = Date.now() + 2000;
        while (collector.configRequests.length === 0 && Date.now() < deadline) await sleep(5);
        await sleep(30);
        return appHandler(e, ctx);
      },
      { flushTimeoutMs: 0 },
    );
    await handler(cloudEvent(), context());
    expect(collector.batchPaths).toEqual(['/v1/ingest']);
    expect(candidates()).toHaveLength(1);
  });

  it('flush(300) right after the wrapped call (the delivery exists by then)', async () => {
    collector.configDelayMs = -1;
    start();
    const handler = wrap(async (_e: unknown, _c: unknown) => ({ statusCode: 202 }), {
      flushTimeoutMs: 0,
    });
    await handler(cloudEvent(), context());
    await flush(300);
    expect(inboundPosts()).toEqual(['/v1/ingest/inbound']);
    expect(candidates()).toHaveLength(1);
  });

  it('flushTimeoutMs: 0 still means no flush for an invocation without a delivery', async () => {
    collector.configDelayMs = -1;
    start({ providers: [{ name: 'Acme', hosts: ['api.acme.test'] }] });
    const { track } = await import('../src/index.js');
    const handler = wrap(
      async (_e: unknown, _c: unknown) => {
        track({ url: 'https://api.acme.test/v1/cards/1', status: 200, durationMs: 5 });
        return { statusCode: 200 };
      },
      { flushTimeoutMs: 0 },
    );
    // not an HTTP event: no delivery
    await handler({ Records: [] }, context());
    expect(collector.requests).toEqual([]);
    expect(getStats()!.queued).toBe(1);
  });

  it("the delivery's flush keeps to the Lambda deadline", async () => {
    collector.configDelayMs = -1;
    start();
    const handler = wrap(async (_e: unknown, _c: unknown) => ({ statusCode: 200 }), {
      flushTimeoutMs: 0,
    });
    const t0 = Date.now();
    await handler(cloudEvent(), context(40)); // less than the 50 ms margin left
    expect(Date.now() - t0).toBeLessThan(40);
    expect(collector.requests).toEqual([]);
  });
});

describe("debug: 'inbound' and getStats().inbound", () => {
  /** THEIRSIDE_DEBUG=inbound / debug: 'inbound' lines written to console.warn. */
  function lines() {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return () =>
      spy.mock.calls
        .map((c) => String(c[0]).replace(/^\[theirside\] /, ''))
        // the fake collector runs in this process: its own requests are traced too
        .filter(
          (l) =>
            l.startsWith('inbound') && !/^inbound (GET|POST) \/v1\/(sdk-config|ingest)/.test(l),
        );
  }

  it('the init option turns the lines on without THEIRSIDE_DEBUG; one line per flush', async () => {
    expect(process.env.THEIRSIDE_DEBUG).toBeUndefined();
    const out = lines();
    collector.configDelayMs = -1;
    start({ debug: 'inbound' });
    await wrap(appHandler, { flushTimeoutMs: 0 })(cloudEvent(), context());
    expect(out()).toEqual([
      expect.stringMatching(
        /^inbound POST \/v1\/notifyco: candidate \/v1\/notifyco, suggested name notifyco/,
      ),
      // the app's own flush, inside the handler: the delivery isn't recorded yet
      'inbound flush: nothing to send',
      // wrap()'s, after the handler
      'inbound flush: 1 candidate to /v1/ingest/inbound: 202',
    ]);
  });

  it('without the option or the variable, no lines', async () => {
    const out = lines();
    collector.configDelayMs = -1;
    start();
    await wrap(appHandler, { flushTimeoutMs: 0 })(cloudEvent(), context());
    expect(out()).toEqual([]);
  });

  it('a collector error: the status, and the deliveries kept for the next flush', async () => {
    const out = lines();
    collector.configDelayMs = -1;
    collector.status = 503;
    start({ debug: 'inbound' });
    await wrap(async (_e: unknown, _c: unknown) => ({ statusCode: 200 }))(cloudEvent(), context());
    expect(out().at(-1)).toBe(
      'inbound flush: 1 candidate to /v1/ingest/inbound: 503; 1 candidate held: kept for the next flush',
    );
    expect(getStats()!.inbound).toMatchObject({ support: 'unknown', held: 1, sent: 0, dropped: 0 });
  });

  it('a collector that never answers: not sent, timeout', async () => {
    const net = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const hang = net.createServer((s) => sockets.push(s)); // accepts, never answers
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const out = lines();
    init({
      apiKey: 'k',
      endpoint: `http://127.0.0.1:${(hang.address() as import('node:net').AddressInfo).port}`,
      service: 'webhooks-fn',
      serverless: true,
      flushIntervalMs: 600_000,
      remoteConfig: false,
      autoDiscover: false,
      debug: 'inbound',
    });
    const t0 = Date.now();
    await wrap(async (_e: unknown, _c: unknown) => ({ statusCode: 200 }), { flushTimeoutMs: 100 })(
      cloudEvent(),
      context(),
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out().at(-1)).toBe('inbound flush: 1 candidate not sent: timeout (still in flight)');
    await shutdown(0);
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => hang.close(() => r()));
  });

  it('without inbound: true, deliveries wait for the remote config: "held"', async () => {
    const out = lines();
    collector.configDelayMs = -1;
    start({ inbound: false, debug: 'inbound', serverless: false });
    await wrap(async (_e: unknown, _c: unknown) => ({ statusCode: 200 }))(cloudEvent(), context());
    expect(out().at(-1)).toBe(
      'inbound flush: 1 candidate held: waiting for the remote config to confirm the collector stores inbound webhooks',
    );
    expect(collector.requests).toEqual([]);
  });

  it('counts held, sent, dropped and candidates', async () => {
    collector.configDelayMs = -1;
    start();
    const handler = wrap(appHandler, { flushTimeoutMs: 0 });
    await handler(cloudEvent(), context());
    await handler(cloudEvent('/v1/payco', 'com.payco'), context());
    expect(getStats()!.inbound).toEqual({
      support: 'yes', // the first batch was accepted
      held: 0,
      sent: 2,
      dropped: 0,
      candidates: { seen: 2, sent: 2 },
    });
  });

  it('a collector without the inbound route: dropped, and recording stops', async () => {
    collector.configDelayMs = -1;
    collector.noInboundRoute = true;
    start();
    const handler = wrap(appHandler, { flushTimeoutMs: 0 });
    await handler(cloudEvent(), context());
    await handler(cloudEvent('/v1/payco', 'com.payco'), context());
    expect(getStats()!.inbound).toEqual({
      support: 'no',
      held: 0,
      sent: 0,
      dropped: 1,
      candidates: { seen: 1, sent: 0 },
    });
  });
});
