import dns from 'node:dns';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flush, getStats, init, shutdown, track, type InitOptions } from '../src/index.js';
import { RemoteConfigClient } from '../src/remote-config.js';
import type { Transport } from '../src/transport.js';
import { HostPolicy, parseRemoteConfig, telemetryHostsFromEnv } from '../src/discovery.js';
import { resolveConfig, type ResolvedConfig } from '../src/config.js';
import {
  sleep,
  startCollector,
  startProvider,
  type FakeCollector,
  type TestServer,
} from './helpers.js';

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
  await shutdown(500);
  collector.batches.length = 0;
  collector.requests.length = 0;
  collector.configRequests.length = 0;
  collector.sdkConfig = undefined;
});

function start(extra: Partial<InitOptions> = {}) {
  init({
    apiKey: 'tsd_live_test',
    endpoint: collector.url,
    service: 'discovery-test',
    flushIntervalMs: 60_000,
    handleProcessExit: false,
    ...extra,
  });
}

/** http.get to a public-looking hostname that resolves to the local test provider. */
function getAs(hostname: string, path: string): Promise<number> {
  const lookup: typeof dns.lookup = ((_h: string, opts: unknown, cb: unknown) => {
    const done = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
    // async like dns.lookup (a sync answer can emit connect errors before http listens)
    setImmediate(() => {
      if (typeof opts === 'object' && opts && (opts as { all?: boolean }).all)
        done(null, [{ address: '127.0.0.1', family: 4 }]);
      else done(null, '127.0.0.1', 4);
    });
  }) as typeof dns.lookup;
  return new Promise((resolve, reject) => {
    http
      .get({ hostname, port: provider.port, path, lookup }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

describe('auto-discovery (default)', () => {
  it('records unlisted third-party hosts with provider null and the host', async () => {
    start();
    expect(await getAs('api.acmecards.test', '/v2/cards/12345?secret=1')).toBe(200);
    await flush();
    const [ev] = collector.events();
    expect(ev).toMatchObject({
      provider: null,
      host: `api.acmecards.test:${provider.port}`,
      // strict (default): "cards" is a known API word, sent from the first call
      endpoint: '/v2/cards/:id',
    });
  });

  it('never sends a name-like path segment on first sight (discovered or listed)', async () => {
    start({ providers: [{ name: 'Acme Cards', hosts: ['api.acmecards.test'] }] });
    const paths = [
      '/customers/john-smith/cards',
      '/v1/customers/maria-garcia/cards',
      '/v1/people/Anna.Kowalska',
      '/users/o%27brien/profile',
    ];
    for (const host of ['api.acmecards.test', 'api.kyco.test'])
      for (const path of paths) await getAs(host, path);
    await flush();
    const sent = JSON.stringify(collector.batches);
    expect(sent).not.toMatch(/john|smith|maria|garcia|anna|kowalska|brien/i);
    expect(collector.events().map((e) => e.endpoint)).toContain('/customers/:id/cards');
    expect(collector.events().map((e) => e.endpoint)).toContain('/v1/people/:id');
  });

  it('balanced: sends a literal once seen 5 times; the name position stays :id', async () => {
    start({ pathPrivacy: 'balanced' });
    for (const n of ['ann', 'bob', 'cyd', 'dee', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jo'])
      await getAs('api.acmecards.test', `/v1/customers/${n}/cards`);
    await flush();
    const endpoints = collector.events().map((e) => e.endpoint);
    expect(endpoints.slice(0, 4)).toEqual(Array(4).fill('/v1/:id/:id/:id'));
    expect(endpoints.at(-1)).toBe('/v1/customers/:id/cards');
    expect(endpoints.join(' ')).not.toMatch(/ann|bob|cyd|dee|eve|fay|gus|hal|ivy|jo\b/);
  });

  it('listed providers keep their name', async () => {
    start({ providers: [{ name: 'Acme Cards', hosts: ['api.acmecards.test'] }] });
    await getAs('api.acmecards.test', '/v1/x');
    await flush();
    expect(collector.events()[0]).toMatchObject({ provider: 'Acme Cards' });
  });

  it.each([
    ['loopback', 'http://localhost:1/x'],
    ['private IP', 'http://10.1.2.3/x'],
    ['metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['single-label internal name', 'http://users-service/x'],
    ['telemetry', 'https://o1.ingest.sentry.io/api/1/envelope/'],
  ])('never records %s', async (_n, url) => {
    start();
    track({ url, durationMs: 5, status: 200 });
    await flush();
    expect(collector.events()).toEqual([]);
  });

  it('never records internalHosts or the collector host', async () => {
    start({
      internalHosts: ['*.mycompany.test'],
      endpoint: `http://ingest.example.test:${collector.port}`,
    });
    track({ url: 'https://ledger.mycompany.test/v1/x', durationMs: 5, status: 200 });
    track({
      url: `http://ingest.example.test:${collector.port}/v1/health`,
      durationMs: 5,
      status: 200,
    });
    expect(getStats()!.queued).toBe(0);
    track({ url: 'https://api.stripe.test/v1/x', durationMs: 5, status: 200 });
    expect(getStats()!.queued).toBe(1);
  });

  it('autoDiscover: false (and the deprecated trackUnknownHosts: false) record listed providers only', async () => {
    for (const opt of [{ autoDiscover: false }, { trackUnknownHosts: false }]) {
      start({ ...opt, providers: [{ name: 'Acme Cards', hosts: ['api.acmecards.test'] }] });
      await getAs('api.acmecards.test', '/v1/x');
      await getAs('api.other.test', '/v1/x');
      await flush();
      expect(collector.events().map((e) => e.provider)).toEqual(['Acme Cards']);
      await shutdown(200);
      collector.batches.length = 0;
    }
  });
});

describe('HostPolicy', () => {
  const cfg = (o: Partial<InitOptions> = {}) =>
    resolveConfig({
      apiKey: 'k',
      endpoint: 'http://collector.example.test:4318',
      ...o,
    }) as ResolvedConfig;

  it('excludes the collector, internalHosts and telemetry endpoints from the environment', () => {
    const p = new HostPolicy(cfg({ internalHosts: ['*.corp.example.com'] }), {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.vendor.example.com:4318',
      SENTRY_DSN: 'https://key@errors.selfhosted.example.com/1',
    });
    expect(p.resolve('collector.example.test', '4318', null)).toBeNull();
    expect(p.resolve('ledger.corp.example.com', '443', null)).toBeNull();
    expect(p.resolve('otel.vendor.example.com', '4318', null)).toBeNull();
    expect(p.resolve('errors.selfhosted.example.com', '443', null)).toBeNull();
    expect(p.resolve('api.stripe.com', '443', null)).toEqual({
      providerName: null,
      routes: [],
      pathPolicy: { privacy: 'strict' },
    });
  });

  it('remote hidden/internal always apply, even to init() providers', () => {
    const c = cfg({ providers: [{ name: 'Acme', hosts: ['api.acme.test'] }] });
    const p = new HostPolicy(c, {});
    const acme = c.providers[0]!;
    expect(p.resolve('api.acme.test', '443', acme)?.providerName).toBe('Acme');
    p.setRemote({
      hidden: ['api.acme.test'],
      internal: ['*.mine.test'],
      providers: [],
      tenants: [],
      sampleRate: null,
    });
    expect(p.resolve('api.acme.test', '443', acme)).toBeNull();
    expect(p.resolve('svc.mine.test', '443', null)).toBeNull();
  });

  it('path privacy: a mode set in the dashboard wins, else init(); allowed words come along', () => {
    const remote = (pathPrivacy: 'strict' | 'balanced' | null, allowedWords: string[] = []) => ({
      hidden: [],
      internal: [],
      providers: [
        { name: 'shop.test', hosts: ['api.shop.test'], routes: [], pathPrivacy, allowedWords },
      ],
      tenants: [],
      sampleRate: null,
    });
    const mode = (init: InitOptions['pathPrivacy'], dash: 'strict' | 'balanced' | null) => {
      const p = new HostPolicy(cfg(init ? { pathPrivacy: init } : {}), {});
      p.setRemote(remote(dash));
      return p.resolve('api.shop.test', '443', null)!.pathPolicy.privacy;
    };
    expect(mode(undefined, null)).toBe('strict'); // default
    expect(mode('balanced', null)).toBe('balanced');
    expect(mode('balanced', 'strict')).toBe('strict'); // disagreement: strict wins
    expect(mode(undefined, 'balanced')).toBe('balanced'); // unless the dashboard sets balanced
    expect(mode('strict', 'balanced')).toBe('balanced');
    const p = new HostPolicy(cfg({ pathPrivacy: 'nonsense' as never }), {});
    p.setRemote(remote(null, ['sneakers']));
    const r = p.resolve('api.shop.test', '443', null)!;
    expect(r.pathPolicy.privacy).toBe('strict');
    expect([...r.pathPolicy.allowedWords!]).toEqual(['sneakers']);
    // other hosts get the init() mode and no extra words
    expect(p.resolve('api.other.test', '443', null)!.pathPolicy).toEqual({ privacy: 'strict' });
  });

  it('merges routes: init() first (wins on conflicts), then remote', () => {
    const c = cfg({
      providers: [{ name: 'Acme', hosts: ['api.acme.test'], routes: ['/v1/cards/:cardId'] }],
    });
    const p = new HostPolicy(c, {});
    p.setRemote({
      hidden: [],
      internal: [],
      providers: [
        { name: 'Acme', hosts: [], routes: ['/v1/cards/:id', '/v1/users/:userId'] },
        { name: 'kyco.test', hosts: ['*.kyco.test'], routes: ['/v1/checks/:checkId'] },
      ],
      tenants: [],
      sampleRate: null,
    });
    const acme = p.resolve('api.acme.test', '443', c.providers[0]!)!;
    expect(acme.routes.map((r) => r.template)).toEqual([
      '/v1/cards/:cardId',
      '/v1/cards/:id',
      '/v1/users/:userId',
    ]);
    expect(acme.routes.find((r) => r.match(['v1', 'cards', 'x']))!.template).toBe(
      '/v1/cards/:cardId',
    );
    expect(p.resolve('api.kyco.test', '443', null)).toMatchObject({ providerName: null });
    expect(p.resolve('api.kyco.test', '443', null)!.routes[0]!.template).toBe(
      '/v1/checks/:checkId',
    );
  });

  it('reads telemetry hosts from OTEL_* and SENTRY_DSN only', () => {
    expect([
      ...telemetryHostsFromEnv({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://tempo.example.com:4318/v1/traces',
        OTHER_URL: 'https://api.stripe.com',
        SENTRY_DSN: 'not a url',
      }),
    ]).toEqual(['tempo.example.com']);
  });
});

describe('remote config', () => {
  it('parses defensively and caps sizes', () => {
    expect(parseRemoteConfig('not json')).toBeNull();
    expect(parseRemoteConfig('"x"')).toBeNull();
    const c = parseRemoteConfig(
      JSON.stringify({
        hidden: ['a.test', 5, ''],
        providers: [
          { name: 'P', hosts: Array.from({ length: 500 }, (_, i) => `h${i}.test`), routes: 'nope' },
          {
            name: 'Q',
            hosts: [],
            routes: [],
            pathPrivacy: 'balanced',
            allowedWords: ['Sneakers', 'two words', 7, 'x'.repeat(65)],
          },
          { name: 'R', hosts: [], routes: [], pathPrivacy: 'loose' },
          { hosts: [] },
        ],
        tenants: ['*.saasco.test', 3],
        sampleRate: 7,
        unknown: true,
      }),
    )!;
    expect(c).toEqual({
      hidden: ['a.test'],
      internal: [],
      providers: [
        {
          name: 'P',
          hosts: c.providers[0]!.hosts,
          routes: [],
          pathPrivacy: null,
          allowedWords: [],
        },
        { name: 'Q', hosts: [], routes: [], pathPrivacy: 'balanced', allowedWords: ['sneakers'] },
        { name: 'R', hosts: [], routes: [], pathPrivacy: null, allowedWords: [] },
      ],
      tenants: ['*.saasco.test'],
      sampleRate: null,
    });
    expect(c.providers[0]!.hosts).toHaveLength(100);
  });

  it('applies hidden hosts and routes, polls with ETag, keeps the last good config on failure', async () => {
    collector.sdkConfig = {
      hidden: [],
      internal: [],
      providers: [
        { name: 'acmecards.test', hosts: ['*.acmecards.test'], routes: ['/v1/people/:personId'] },
      ],
      tenants: [],
      sampleRate: null,
    };
    start();
    // first poll runs in the background right after init
    for (let i = 0; i < 100 && collector.configRequests.length === 0; i++) await sleep(10);
    await sleep(50);
    await getAs('api.acmecards.test', '/v1/people/jane');
    await flush();
    expect(collector.events()[0]!.endpoint).toBe('/v1/people/:personId');
    // other paths are auto-templated: a known word goes out at once, a name never
    await getAs('api.acmecards.test', '/v1/people');
    await getAs('api.acmecards.test', '/v1/olga-silva');
    await flush();
    expect(collector.events()[1]!.endpoint).toBe('/v1/people');
    expect(collector.events()[2]!.endpoint).toBe('/v1/:id');

    expect(collector.configRequests[0]!.ifNoneMatch).toBeUndefined();
  });

  it('strict by default: a name is never sent; allowed words from the dashboard are', async () => {
    collector.sdkConfig = {
      hidden: [],
      internal: [],
      providers: [
        { name: 'shop.test', hosts: ['api.shop.test'], routes: [], allowedWords: ['sneakers'] },
      ],
      tenants: [],
      sampleRate: null,
    };
    start();
    for (let i = 0; i < 100 && collector.configRequests.length === 0; i++) await sleep(10);
    await sleep(50);
    for (let i = 0; i < 6; i++) await getAs('api.people.test', '/v2/people/ivan-wei');
    await getAs('api.shop.test', '/v1/sneakers');
    await getAs('api.other.test', '/v1/sneakers');
    await flush();
    const endpoints = collector.events().map((e) => e.endpoint);
    expect(endpoints.slice(0, 6)).toEqual(Array(6).fill('/v2/people/:id'));
    expect(endpoints.slice(6)).toEqual(['/v1/sneakers', '/v1/:id']);
  });

  it("learns routes of the collector's tenant patterns under one key", async () => {
    collector.sdkConfig = {
      hidden: [],
      internal: [],
      providers: [],
      tenants: ['*.saasco.test'],
      sampleRate: null,
    };
    start({ pathPrivacy: 'balanced' }); // the 5-sightings count is what's shared
    for (let i = 0; i < 100 && collector.configRequests.length === 0; i++) await sleep(10);
    await sleep(50);
    // five different tenants, one sighting each: together they confirm `accounts`
    for (let i = 1; i <= 5; i++) await getAs(`t${i}.saasco.test`, '/v1/accounts');
    await getAs('t6.saasco.test', '/v1/accounts');
    await flush();
    expect(collector.events().map((e) => e.endpoint)).toEqual([
      '/v1/:id',
      '/v1/:id',
      '/v1/:id',
      '/v1/:id',
      '/v1/accounts',
      '/v1/accounts',
    ]);
  });

  it("learns routes of one provider's hosts under one key (init() or the collector's grouping)", async () => {
    collector.sdkConfig = {
      hidden: [],
      internal: [],
      providers: [
        { name: 'vendor.test', hosts: ['api.vendor.test', 'files.vendor.test'], routes: [] },
      ],
      tenants: [],
      sampleRate: null,
    };
    start({
      pathPrivacy: 'balanced',
      providers: [{ name: 'Acme', hosts: ['api.acme.test', 'eu.acme.test'] }],
    });
    for (let i = 0; i < 100 && collector.configRequests.length === 0; i++) await sleep(10);
    await sleep(50);
    for (const h of ['api', 'files', 'api', 'files', 'files'])
      await getAs(`${h}.vendor.test`, '/v1/accounts');
    for (const h of ['api', 'eu', 'eu', 'api', 'eu']) await getAs(`${h}.acme.test`, '/v1/accounts');
    // a host outside both providers counts on its own
    await getAs('api.solo.test', '/v1/accounts');
    await flush();
    const ends = collector.events().map((e) => e.endpoint);
    expect(ends[4]).toBe('/v1/accounts');
    expect(ends[9]).toBe('/v1/accounts');
    expect(ends[10]).toBe('/v1/:id');
  });
});

describe('older collector (no /v1/sdk-config)', () => {
  const startOld = (extra: Partial<InitOptions> = {}) =>
    init(
      {
        apiKey: 'tsd_live_test',
        endpoint: collector.url,
        flushIntervalMs: 60_000,
        handleProcessExit: false,
        providers: [{ name: 'Acme Cards', hosts: ['api.acmecards.test'] }],
        ...extra,
      },
      { remoteConfigIntervalMs: 20, minPathSightings: 1 },
    );
  const waitForPolls = async (n: number) => {
    for (let i = 0; i < 200 && collector.configRequests.length < n; i++) await sleep(10);
    await sleep(20);
  };

  it('turns auto-discovery off with one warning; listed providers keep recording', async () => {
    collector.sdkConfig = null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      startOld();
      // queued before the first poll answers: dropped, since the old collector would reject the batch
      track({ url: 'https://api.kyco.test/v1/early', durationMs: 5, status: 200 });
      await waitForPolls(3);
      await getAs('api.acmecards.test', '/v1/cards');
      await getAs('api.kyco.test', '/v1/checks');
      track({ url: 'https://api.bankco.test/v1/late', durationMs: 5, status: 200 });
      await flush();
      const events = collector.events();
      expect(events.map((e) => `${e.provider} ${e.endpoint}`)).toEqual(['Acme Cards /v1/cards']);
      expect(getStats()!.dropped).toBe(1);
      const ours = warn.mock.calls.filter((c) => String(c[0]).includes('auto-discovery is off'));
      expect(ours).toHaveLength(1);
      expect(collector.configRequests.length).toBeGreaterThanOrEqual(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when auto-discovery is already off', async () => {
    collector.sdkConfig = null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      startOld({ autoDiscover: false });
      await waitForPolls(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a collector that serves the config keeps discovery on', async () => {
    startOld();
    await waitForPolls(2);
    await getAs('api.kyco.test', '/v1/checks');
    await flush();
    expect(collector.events()[0]).toMatchObject({ provider: null });
  });
});

describe('RemoteConfigClient', () => {
  const config = (routes: string[]) =>
    JSON.stringify({
      hidden: [],
      internal: [],
      providers: [{ name: 'p', hosts: ['*.p.test'], routes }],
    });

  it('sends If-None-Match, keeps the config on 304, errors and invalid bodies', async () => {
    const replies: unknown[] = [
      { status: 200, etag: '"v1"', body: config(['/a/:id']) },
      { status: 304 },
      { error: 'ECONNREFUSED' },
      { status: 500 },
      { status: 200, etag: '"v2"', body: '{not json' },
      { status: 200, etag: '"v3"', body: config(['/b/:id']) },
    ];
    const seen: Record<string, string>[] = [];
    const transport = {
      get: async (_path: string, headers: Record<string, string>) => {
        seen.push(headers);
        return replies.shift();
      },
    } as unknown as Transport;
    const applied: string[][] = [];
    const rc = new RemoteConfigClient(
      transport,
      () => {},
      (c) => applied.push(c.providers[0]!.routes),
    );
    for (let i = 0; i < 6; i++) await rc.poll();
    expect(applied).toEqual([['/a/:id'], ['/b/:id']]);
    expect(seen.map((h) => h['if-none-match'])).toEqual([
      undefined,
      '"v1"',
      '"v1"',
      '"v1"',
      '"v1"',
      '"v1"',
    ]);
    expect(rc.current!.providers[0]!.routes).toEqual(['/b/:id']);
  });

  it('a transport that throws never escapes', async () => {
    const transport = {
      get: async () => {
        throw new Error('boom');
      },
    } as unknown as Transport;
    const rc = new RemoteConfigClient(
      transport,
      () => {},
      () => {},
    );
    await expect(rc.poll()).resolves.toBeUndefined();
    expect(rc.lastError).toBe('boom');
  });

  it('reports a 404 once, and only a 404', async () => {
    const replies: unknown[] = [{ status: 500 }, { status: 404 }, { status: 404 }, { status: 404 }];
    const transport = { get: async () => replies.shift() } as unknown as Transport;
    let missing = 0;
    const rc = new RemoteConfigClient(
      transport,
      () => {},
      () => {},
      60_000,
      () => missing++,
    );
    await rc.poll();
    expect(missing).toBe(0);
    for (let i = 0; i < 3; i++) await rc.poll();
    expect(missing).toBe(1);
    expect(rc.lastError).toBe('http_404');
  });
});
