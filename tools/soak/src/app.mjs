// The measured process: a host app making a steady mix of fetch, http and axios
// calls through the BUILT SDK (what users run; no tsx or source condition).
// Started by run.mjs with --expose-gc; config arrives as JSON in SOAK_CONFIG.
// Answers {type:'sample'} with memory + SDK stats after a forced GC, and
// {type:'snapshot', path} with a heap snapshot.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import v8 from 'node:v8';
import axios from 'axios';

const cfg = JSON.parse(process.env.SOAK_CONFIG);
const sdk = cfg.sdk ? await import('@theirside/sdk') : undefined;

sdk?.init({
  apiKey: cfg.apiKey ?? 'tsd_live_soak00000000000000000000',
  endpoint: cfg.endpoint ?? `http://127.0.0.1:${cfg.collectorPort}`,
  service: 'soak',
  environment: 'soak',
  providers: [{ name: 'Soak Provider', hosts: ['localhost'] }],
  flushIntervalMs: 1000,
  handleProcessExit: false,
});

const base = `http://localhost:${cfg.providerPort}`;
const dead = `http://localhost:${cfg.deadPort}`;
// untracked host (provider is configured for `localhost` only)
const untracked = `http://127.0.0.1:${cfg.providerPort}`;
// Every hostname resolves to the local provider, so http/axios calls can use
// public-looking hosts and exercise auto-discovery (fetch keeps using localhost).
// Answers asynchronously like dns.lookup: a synchronous callback lets connect
// errors fire before http attaches its error listener (an unhandled 'error').
const lookup = (_host, opts, cb) => {
  const done = typeof opts === 'function' ? opts : cb;
  setImmediate(() => {
    if (opts && opts.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
    else done(null, '127.0.0.1', 4);
  });
};
const agent = new http.Agent({ keepAlive: true, maxSockets: 50, lookup });
/** Discovered hosts: 20 vendors with a few subdomains, plus 5,000 tenant subdomains. */
const discoveredHost = () =>
  n % 4 === 0
    ? `t${n % 5000}.saasco.test`
    : `${['api', 'files', 'sandbox'][n % 3]}.vendor${n % 20}.test`;

// Paths carry fresh IDs every call (numbers, uuids, tokens) so endpoint
// templating sees an unbounded stream of raw paths, across several domains,
// plus personal names in paths that only path privacy keeps out: hundreds of
// names per host from tools/vocabulary/names.txt, and a small hot set called
// very often (a few big customers), the case frequency alone can't catch.
let n = 0;
const uuid = () => crypto.randomUUID();
const NAMES = readFileSync(new URL('../../vocabulary/names.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const HOT = ['ivan-wei', 'olga-silva', 'maria-garcia', 'john-smith', 'li-na'];
const person = () => (Math.random() < 0.3 ? pick(HOT) : `${pick(NAMES)}-${pick(NAMES)}`);
const slug = () =>
  `${pick(['blue', 'red', 'trail', 'city'])}-${pick(['running', 'walking'])}-${pick(['shoes', 'boots'])}`;
const PATHS = [
  () => `/v1/cards/${100000 + (n % 900000)}/activate`,
  () => `/v2/customers/cus_${uuid().slice(0, 14)}`,
  () => `/v1/payments/${uuid()}`,
  () => `/v1/verifications/${n}/documents/${n % 7}`,
  () => `/v1/accounts`,
  () => `/v1/customers/${person()}/cards`,
  () => `/v2/people/${person()}`,
  () => `/customers/${n}/payment-methods`,
  () => `/orders/${n}/line_items`,
  () => `/shipments/${n}/tracking`,
  () => `/v1/chat/completions`,
  () => `/messages/${uuid()}/attachments`,
  () => `/products/${slug()}`,
];

// kind -> [weight, server route]
const KINDS = [
  ['ok', 70, 'ok'],
  ['http_5xx', 8, 'fail'],
  ['http_4xx', 4, 'notfound'],
  ['timeout', 5, 'hang'],
  ['abort', 5, 'slow'],
  ['refused', 4, null],
  ['reset', 3, 'reset'],
  ['untracked', 1, 'ok'],
];
const TOTAL = KINDS.reduce((s, k) => s + k[1], 0);
function pickKind() {
  let r = n % TOTAL;
  for (const k of KINDS) {
    if (r < k[1]) return k;
    r -= k[1];
  }
  return KINDS[0];
}

let appErrors = 0;
let calls = 0;
const swallow = () => {};

function url(kind, discovered = false) {
  const [name, , route] = kind;
  const path = pick(PATHS)();
  if (name === 'refused') return `${dead}${path}`;
  const origin =
    name === 'untracked'
      ? untracked
      : discovered
        ? `http://${discoveredHost()}:${cfg.providerPort}`
        : base;
  return `${origin}${path}?r=${route}`;
}

function viaFetch(kind) {
  const u = url(kind);
  const name = kind[0];
  const opts = {};
  if (name === 'timeout') opts.signal = AbortSignal.timeout(100);
  if (name === 'abort') {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    opts.signal = ac.signal;
  }
  return fetch(u, opts).then((r) => r.arrayBuffer(), swallow);
}

function viaHttp(kind) {
  const name = kind[0];
  return new Promise((resolve) => {
    const req = http.get(
      url(kind, n % 2 === 0),
      { agent, timeout: name === 'timeout' ? 100 : 5000 },
      (res) => {
        res.resume();
        res.on('end', resolve);
        res.on('error', resolve);
      },
    );
    req.on('error', resolve);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (name === 'abort') setTimeout(() => req.destroy(), 10);
  });
}

function viaAxios(kind) {
  const name = kind[0];
  const opts = { httpAgent: agent, validateStatus: () => true, responseType: 'arraybuffer' };
  if (name === 'timeout') opts.timeout = 100;
  if (name === 'abort') {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    opts.signal = ac.signal;
  }
  return axios.get(url(kind, n % 2 === 1), opts).then(swallow, swallow);
}

const CLIENTS = [viaFetch, viaHttp, viaAxios];
// detector self-test only (run.mjs --leak-bytes)
const leaked = [];
function call() {
  const kind = pickKind();
  const client = CLIENTS[Math.floor(n / TOTAL) % CLIENTS.length];
  n++;
  calls++;
  if (cfg.leakBytes) leaked.push('x'.repeat(cfg.leakBytes) + n);
  try {
    client(kind).catch(() => appErrors++);
  } catch {
    appErrors++;
  }
}

const perTick = Math.max(1, Math.round(cfg.rps / 100));
const traffic = setInterval(() => {
  for (let k = 0; k < perTick; k++) call();
}, 10);

process.on('message', (msg) => {
  if (msg.type === 'sample') {
    global.gc();
    const m = process.memoryUsage();
    const s = sdk?.getStats();
    process.send({
      type: 'sample',
      calls,
      appErrors,
      heapUsed: m.heapUsed,
      rss: m.rss,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
      queued: s?.queued ?? null,
      dropped: s?.dropped ?? null,
      sent: s?.sent ?? null,
      lastFlushError: s?.lastFlushError ?? null,
    });
  } else if (msg.type === 'snapshot') {
    global.gc();
    v8.writeHeapSnapshot(msg.path);
    process.send({ type: 'snapshot', path: msg.path });
  } else if (msg.type === 'stop') {
    clearInterval(traffic);
    Promise.resolve(sdk?.shutdown(1000)).finally(() => {
      agent.destroy();
      process.exit(0);
    });
  }
});
process.send({ type: 'ready' });
