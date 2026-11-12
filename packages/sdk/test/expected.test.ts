import http from 'node:http';
import type net from 'node:net';
import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expecting, flush, getStats, init, markExpected, shutdown, track } from '../src/index.js';
import {
  sleep,
  startCollector,
  startProvider,
  type FakeCollector,
  type TestServer,
} from './helpers.js';

/**
 * Expected outcomes: a 4xx the app reads as a business answer (a consent check
 * answering 400) is tagged with a reason label and counted as successful.
 */
let collector: FakeCollector;
let provider: TestServer;

beforeAll(async () => {
  collector = await startCollector();
  provider = await startProvider();
});
afterAll(async () => {
  await Promise.all([collector.close(), provider.close()]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown(500);
  collector.batches.length = 0;
});

function start(extra: Record<string, unknown> = {}, internals: Record<string, unknown> = {}) {
  init(
    {
      apiKey: 'tsd_live_test',
      endpoint: collector.url,
      flushIntervalMs: 60_000,
      handleProcessExit: false,
      providers: [{ name: 'Local', hosts: ['localhost'] }],
      remoteConfig: false,
      ...extra,
    },
    { minPathSightings: 1, ...internals },
  );
}

async function sent() {
  await flush();
  return collector
    .events()
    .map((e) => ({ endpoint: e.endpoint, status: e.status, expected: e.expected }))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint) || (a.status ?? 0) - (b.status ?? 0));
}

/** Our app: an HTTP server whose handler calls the provider, like a NestJS controller. */
async function startApp(
  handler: (req: http.IncomingMessage) => Promise<number>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req).then(
      (code) => {
        res.statusCode = code;
        res.end();
      },
      () => {
        res.statusCode = 500;
        res.end();
      },
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

describe('markExpected(reason)', () => {
  it('tags the latest call of the incoming request it is called in, with fetch, http and axios', async () => {
    start();
    const app = await startApp(async (req) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const client = url.searchParams.get('client');
      const path = `${provider.url}/status/400/v1/consent`;
      let status: number;
      if (client === 'fetch') {
        const r = await fetch(path);
        await r.text(); // the app reads the answer, then decides
        status = r.status;
      } else if (client === 'axios') {
        status = (await axios.get(path, { validateStatus: () => true })).status;
      } else {
        status = await new Promise<number>((resolve, reject) =>
          http
            .get(path, (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode ?? 0));
            })
            .on('error', reject),
        );
      }
      if (url.searchParams.get('mark') === '1' && status === 400) markExpected('consent_required');
      return 200;
    });
    try {
      for (const client of ['fetch', 'http', 'axios'])
        expect((await fetch(`${app.url}/?client=${client}&mark=1`)).status).toBe(200);
      // the same answer without a mark: stays a failure
      await fetch(`${app.url}/?client=fetch&mark=0`);
      const events = await sent();
      expect(events.filter((e) => e.expected === 'consent_required')).toHaveLength(3);
      expect(events.filter((e) => e.status === 400 && !e.expected)).toHaveLength(1);
      expect(getStats()?.expected).toEqual({ tagged: 3, missed: 0 });
    } finally {
      await app.close();
    }
  });

  it('concurrent requests: each mark tags its own request’s call only', async () => {
    start();
    const app = await startApp(async (req) => {
      const mark = req.url?.includes('mark=1');
      const r = await fetch(`${provider.url}/status/400/v1/consent`);
      await sleep(mark ? 30 : 5); // interleave: the unmarked request's call ends in between
      await r.text();
      if (mark) markExpected('consent_required');
      return 200;
    });
    try {
      await Promise.all([
        ...Array.from({ length: 5 }, () => fetch(`${app.url}/?mark=1`)),
        ...Array.from({ length: 5 }, () => fetch(`${app.url}/?mark=0`)),
      ]);
      const events = await sent();
      expect(events.filter((e) => e.expected)).toHaveLength(5);
      expect(events.filter((e) => !e.expected)).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it('tags nothing and counts a miss: outside a request, after a success, too late, a bad reason', async () => {
    start({}, { expectedWindowMs: 200 });
    // no incoming request around it
    await fetch(`${provider.url}/status/400/v1/consent`).then((r) => r.text());
    markExpected('consent_required');
    const app = await startApp(async (req) => {
      const which = new URL(req.url ?? '/', 'http://x').searchParams.get('case');
      if (which === 'success') {
        await fetch(`${provider.url}/status/400/v1/consent`).then((r) => r.text());
        await fetch(`${provider.url}/v1/profile`).then((r) => r.text()); // latest call: a 200
        markExpected('consent_required');
      } else if (which === 'late') {
        await fetch(`${provider.url}/status/400/v1/consent`).then((r) => r.text());
        await sleep(300);
        markExpected('consent_required');
      } else if (which === 'bad') {
        await fetch(`${provider.url}/status/400/v1/consent`).then((r) => r.text());
        markExpected('the user has not consented!');
      } else {
        markExpected('consent_required'); // no call yet
      }
      return 200;
    });
    try {
      for (const c of ['success', 'late', 'bad', 'none']) await fetch(`${app.url}/?case=${c}`);
      expect((await sent()).filter((e) => e.expected)).toEqual([]);
      expect(getStats()?.expected).toEqual({ tagged: 0, missed: 5 });
    } finally {
      await app.close();
    }
  });

  it('a call already sent can no longer be tagged', async () => {
    start();
    const app = await startApp(async () => {
      await fetch(`${provider.url}/status/400/v1/consent`).then((r) => r.text());
      await flush(); // forced: sent at once
      markExpected('consent_required');
      return 200;
    });
    try {
      await fetch(app.url);
      expect((await sent()).filter((e) => e.expected)).toEqual([]);
      expect(getStats()?.expected.missed).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('once used, holds fresh 4xx answers from the periodic flush until the window has passed', async () => {
    start({ flushIntervalMs: 50 }, { expectedWindowMs: 400 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = await startApp(async () => {
      await fetch(`${provider.url}/status/400/v1/consent`).then((r) => r.text());
      await gate; // the app takes a while before it decides
      markExpected('consent_required');
      return 200;
    });
    try {
      const done = fetch(app.url);
      markExpected('warm_up'); // first use turns holding on (counts a miss: no call here)
      await sleep(200);
      expect(collector.events()).toHaveLength(0); // held, though the flush ran several times
      release();
      await done;
      await sleep(600);
      expect(collector.events().map((e) => e.expected)).toEqual(['consent_required']);
    } finally {
      await app.close();
    }
  });
});

describe('expecting(reason, fn)', () => {
  it('tags 4xx answers to calls made inside, async ones too, and returns what fn returns', async () => {
    start();
    const result = await expecting('consent_required', async () => {
      await fetch(`${provider.url}/status/400/v1/consent`).then((r) => r.text());
      await axios.get(`${provider.url}/status/404/v1/consent`, { validateStatus: () => true });
      await fetch(`${provider.url}/v1/profile`).then((r) => r.text()); // 200: nothing to tag
      await fetch(`${provider.url}/status/503/v1/consent`).then((r) => r.text()); // never
      return 'done';
    });
    expect(result).toBe('done');
    await fetch(`${provider.url}/status/400/v1/consent`).then((r) => r.text()); // outside
    const events = await sent();
    expect(events.filter((e) => e.expected === 'consent_required').map((e) => e.status)).toEqual([
      400, 404,
    ]);
    expect(
      events
        .filter((e) => !e.expected)
        .map((e) => e.status)
        .sort(),
    ).toEqual([200, 400, 503]);
  });

  it('nested scopes: the inner reason wins; track() inside is tagged too', async () => {
    start();
    await expecting('outer', async () => {
      await expecting('inner', () =>
        fetch(`${provider.url}/status/400/v1/a`).then((r) => r.text()),
      );
      track({ url: `${provider.url}/v1/b`, status: 409, durationMs: 3 });
    });
    const events = await sent();
    expect(events.map((e) => [e.status, e.expected]).sort()).toEqual([
      [400, 'inner'],
      [409, 'outer'],
    ]);
  });

  it('rethrows, runs fn with a bad reason, and works before init()', async () => {
    await expect(
      expecting('x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(expecting('not a label', () => 7)).toBe(7);
    start();
    expect(() =>
      expecting('x', () => {
        throw new Error('sync');
      }),
    ).toThrow('sync');
  });
});
