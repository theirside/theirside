import http from 'node:http';

/** The fake providers served by tools/chaos-provider (docker network aliases). */
export interface FakeProvider {
  name: string;
  host: string;
  calls: { method: 'GET' | 'POST'; path: () => string; weight: number; client: 'http' | 'fetch' }[];
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/**
 * Provider-style IDs (`card_4f9KdL2x`): always contain a digit, like real ones,
 * so auto templating collapses them. (Letters-only random IDs would not be
 * recognised; providers using those need explicit `routes` in the SDK config.)
 */
const id = (prefix: string) => {
  let s = String(Math.floor(Math.random() * 10));
  for (let i = 0; i < 9; i++) s += B62[Math.floor(Math.random() * 62)];
  return `${prefix}_${s}`;
};

export function fakeProviders(
  port: number,
  hosts = { acme: 'api.acmecards.test', kyc: 'api.kyco.test', bank: 'api.bankco.test' },
) {
  const withPort = (h: string) => `${h}:${port}`;
  const providers: FakeProvider[] = [
    {
      name: 'acmecards.test',
      host: withPort(hosts.acme),
      calls: [
        {
          method: 'POST',
          path: () => `/v2/cards/${id('card')}/activate`,
          weight: 3,
          client: 'http',
        },
        { method: 'GET', path: () => `/v2/cards/${id('card')}`, weight: 3, client: 'http' },
        { method: 'POST', path: () => '/v2/cards', weight: 2, client: 'http' },
      ],
    },
    {
      name: 'kyco.test',
      host: withPort(hosts.kyc),
      calls: [
        { method: 'POST', path: () => '/v1/kyc/checks', weight: 2, client: 'fetch' },
        { method: 'GET', path: () => `/v1/kyc/checks/${id('chk')}`, weight: 2, client: 'fetch' },
      ],
    },
    {
      name: 'bankco.test',
      host: withPort(hosts.bank),
      calls: [
        { method: 'POST', path: () => '/v1/transfers', weight: 2, client: 'http' },
        {
          method: 'GET',
          path: () => `/v1/accounts/${id('acc')}/balance`,
          weight: 2,
          client: 'fetch',
        },
      ],
    },
  ];
  return providers;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });

function httpCall(method: string, url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(url, { method, agent, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

async function fetchCall(method: string, url: string, timeoutMs: number): Promise<number> {
  try {
    const res = await fetch(url, {
      method,
      ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

export interface TrafficStats {
  calls: number;
  failures: number;
}

/** Call the fake providers at roughly `rps` calls/second until stop() (weighted endpoint mix). */
export function startDirectTraffic(providers: FakeProvider[], rps: number, timeoutMs = 5000) {
  const pool = providers.flatMap((p) =>
    p.calls.flatMap((c) => Array.from({ length: c.weight }, () => ({ p, c }))),
  );
  const stats: TrafficStats = { calls: 0, failures: 0 };
  const perTick = rps / 10;
  let carry = 0;
  const timer = setInterval(() => {
    carry += perTick;
    while (carry >= 1) {
      carry -= 1;
      const { p, c } = pool[Math.floor(Math.random() * pool.length)]!;
      const url = `http://${p.host}${c.path()}`;
      stats.calls++;
      void (
        c.client === 'http'
          ? httpCall(c.method, url, timeoutMs)
          : fetchCall(c.method, url, timeoutMs)
      ).then((s) => {
        if (s === 0 || s >= 500) stats.failures++;
      });
    }
  }, 100);
  return { stats, stop: () => clearInterval(timer) };
}

/** Call the NestJS demo app's endpoints (each fans out to providers). */
export function startDemoTraffic(baseUrl: string, rps: number) {
  const routes = [
    { method: 'POST', path: () => `/cards/${id('card')}/activate`, weight: 3 },
    { method: 'GET', path: () => `/cards/${id('card')}`, weight: 3 },
    { method: 'POST', path: () => '/onboarding', weight: 2 },
    { method: 'POST', path: () => '/payouts', weight: 2 },
  ];
  const pool = routes.flatMap((r) => Array.from({ length: r.weight }, () => r));
  const stats: TrafficStats = { calls: 0, failures: 0 };
  const perTick = rps / 10;
  let carry = 0;
  const timer = setInterval(() => {
    carry += perTick;
    while (carry >= 1) {
      carry -= 1;
      const r = pool[Math.floor(Math.random() * pool.length)]!;
      stats.calls++;
      void httpCall(r.method, `${baseUrl}${r.path()}`, 15_000).then((s) => {
        if (s === 0 || s >= 500) stats.failures++;
      });
    }
  }, 100);
  return { stats, stop: () => clearInterval(timer) };
}
