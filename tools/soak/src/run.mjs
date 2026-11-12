// SDK memory soak runner (docs/benchmarks.md). Hosts the fake provider and the
// fake collector in THIS process and forks the measured host app (app.mjs), so
// only the app's memory is sampled.
//
//   node src/run.mjs [--minutes 60 | --hours N] [--warmup 5] [--rps 300] [--inbound-rps 20] [--sample-seconds 10]
//                    [--collector up|down|cycle|external] [--cycle-minutes 10] [--no-sdk]
//                    [--endpoint URL --api-key KEY] [--snapshots 300,3300] [--out soak.csv]
//                    [--ci] [--max-growth-mb 1] [--project-minutes N] [--leak-bytes 0]
//
// --collector external sends to a real collector (--endpoint, --api-key)
// instead of the in-process fake; down = a closed port. The CSV (--out) is
// written as samples arrive. SIGTERM/SIGINT end the run early and still report.
//
// Needs the built SDK (`pnpm --filter @theirside/sdk build`). Reports the heap
// slope after warm-up (least squares, MB/hour) and the growth it implies over
// the measured window (or --project-minutes). With --ci, exits 1 when that
// growth reaches --max-growth-mb with a clear trend (R^2 >= 0.5). --leak-bytes
// makes the app leak that much per call, to check the detector itself.
// Take heap snapshots only in diagnostic runs: writing one inflates RSS.
import { fork } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const MINUTES = opt('hours') !== undefined ? Number(opt('hours')) * 60 : Number(opt('minutes', 60));
const WARMUP = Number(opt('warmup', 5));
const RPS = Number(opt('rps', 300));
/** Requests the app receives per second (webhooks, candidates, API and browser requests). */
const INBOUND_RPS = Number(opt('inbound-rps', 20));
const SAMPLE_MS = Number(opt('sample-seconds', 10)) * 1000;
const MODE = opt('collector', 'cycle');
const CYCLE_MS = Number(opt('cycle-minutes', 10)) * 60_000;
const SDK = !argv.includes('--no-sdk');
const SNAPSHOTS = String(opt('snapshots', ''))
  .split(',')
  .filter(Boolean)
  .map((s) => Number(s) * 1000);
const OUT = opt('out', undefined);
const MAX_GROWTH_MB = Number(opt('max-growth-mb', 1));
const CI = argv.includes('--ci');
const LEAK_BYTES = Number(opt('leak-bytes', 0));
const ENDPOINT = opt('endpoint', undefined);
const API_KEY = opt('api-key', undefined);
if (MODE === 'external' && !ENDPOINT) throw new Error('--collector external needs --endpoint');
const MB = 1048576;

const listen = (srv, port = 0) =>
  new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv.address().port)));

// Provider: ?r=ok|fail|notfound|hang|slow|reset
const provider = http.createServer((req, res) => {
  req.resume();
  const route = new URL(req.url, 'http://x').searchParams.get('r');
  if (route === 'hang') return; // the client's timeout ends it
  if (route === 'reset') return req.socket.destroy();
  if (route === 'slow') {
    const t = setTimeout(() => res.end('{"ok":true}'), 50);
    res.on('close', () => clearTimeout(t));
    return;
  }
  res.statusCode = route === 'fail' ? 503 : route === 'notfound' ? 404 : 200;
  res.setHeader('x-request-id', `req_${Math.random().toString(36).slice(2, 10)}`);
  res.end('{"ok":true}');
});

let batches = 0;
const collector = http.createServer((req, res) => {
  req.resume();
  if (req.method === 'GET') {
    // remote config, like a current collector
    res.setHeader('content-type', 'application/json');
    return res.end('{"hidden":[],"internal":[],"providers":[],"sampleRate":null,"inbound":true}');
  }
  req.on('end', () => {
    batches++;
    res.statusCode = 202;
    res.end('{}');
  });
});

const providerPort = await listen(provider);
const collectorPort = await listen(collector);
const deadSrv = net.createServer();
const deadPort = await listen(deadSrv);
await new Promise((r) => deadSrv.close(r));

let collectorUp = true;
async function setCollector(up) {
  if (up === collectorUp) return;
  collectorUp = up;
  if (up) await listen(collector, collectorPort);
  else {
    collector.closeAllConnections();
    await new Promise((r) => collector.close(r));
  }
}
if (MODE === 'down') await setCollector(false);
if (MODE === 'external') await setCollector(false); // the fake isn't used

const here = path.dirname(fileURLToPath(import.meta.url));
const child = fork(path.join(here, 'app.mjs'), [], {
  execArgv: ['--expose-gc'],
  env: {
    ...process.env,
    SOAK_CONFIG: JSON.stringify({
      sdk: SDK,
      rps: RPS,
      inboundRps: INBOUND_RPS,
      providerPort,
      collectorPort,
      deadPort,
      leakBytes: LEAK_BYTES,
      ...(MODE === 'external' ? { endpoint: ENDPOINT, apiKey: API_KEY } : {}),
    }),
  },
});
const pending = [];
child.on('message', (m) => pending.shift()?.(m));
const ask = (msg) =>
  new Promise((resolve) => {
    pending.push(resolve);
    child.send(msg);
  });
await new Promise((r) => child.once('message', r)); // ready

console.log(
  `soak: ${MINUTES} min (warm-up ${WARMUP}), ${RPS} calls/s, ${INBOUND_RPS} incoming/s, collector=${MODE}, sdk=${SDK ? 'on' : 'off'}, node ${process.version}`,
);
console.log(
  'elapsed  collector  heapMB  rssMB  extMB  calls     queued  dropped   sent      flushErr',
);

const COLS = [
  't',
  'collector',
  'heapUsed',
  'rss',
  'external',
  'arrayBuffers',
  'calls',
  'appErrors',
  'queued',
  'dropped',
  'sent',
  'lastFlushError',
  'received',
  'inboundSent',
  'inboundHeld',
  'inboundDropped',
  'candidatesSeen',
  'expectedTagged',
];
if (OUT) writeFileSync(OUT, COLS.join(',') + '\n');

let stopping = false;
let wake = () => {};
for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${sig}: stopping early`);
    wake();
  });

const started = Date.now();
const rows = [];
let nextSnapshot = 0;
while (!stopping && Date.now() - started < MINUTES * 60_000) {
  await new Promise((r) => {
    const t = setTimeout(r, SAMPLE_MS - ((Date.now() - started) % SAMPLE_MS));
    wake = () => {
      clearTimeout(t);
      r();
    };
  });
  if (stopping) break;
  const elapsed = Date.now() - started;
  if (MODE === 'cycle') await setCollector(Math.floor(elapsed / CYCLE_MS) % 2 === 0);
  if (nextSnapshot < SNAPSHOTS.length && elapsed >= SNAPSHOTS[nextSnapshot]) {
    const file = path.resolve(`soak-${Math.round(elapsed / 1000)}s.heapsnapshot`);
    await ask({ type: 'snapshot', path: file });
    console.log(`         heap snapshot: ${file}`);
    nextSnapshot++;
  }
  const s = await ask({ type: 'sample' });
  const row = {
    t: elapsed / 1000,
    collector: MODE === 'external' ? 'external' : collectorUp ? 'up' : 'down',
    ...s,
  };
  rows.push(row);
  if (OUT) appendFileSync(OUT, COLS.map((c) => csvCell(row[c])).join(',') + '\n');
  console.log(
    [
      `${Math.round(row.t)}s`.padEnd(8),
      row.collector.padEnd(10),
      (s.heapUsed / MB).toFixed(2).padEnd(7),
      (s.rss / MB).toFixed(0).padEnd(6),
      (s.external / MB).toFixed(1).padEnd(6),
      String(s.calls).padEnd(9),
      String(s.queued ?? '-').padEnd(7),
      String(s.dropped ?? '-').padEnd(9),
      String(s.sent ?? '-').padEnd(9),
      s.lastFlushError ?? '-',
    ].join(' '),
  );
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const str = String(v);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const exited = new Promise((r) => child.once('exit', r));
child.send({ type: 'stop' });
await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
child.kill();
provider.closeAllConnections();
provider.close();
if (collectorUp) {
  collector.closeAllConnections();
  collector.close();
}

/** Least-squares slope (per minute) and R^2 of y over x (minutes). */
function trend(points) {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
}

const measured = rows.filter((r) => r.t >= WARMUP * 60);
const windowMin = Number(opt('project-minutes', MINUTES - WARMUP));
const report = (label, filter, field) => {
  const pts = measured.filter(filter).map((r) => [r.t / 60, r[field] / MB]);
  if (pts.length < 3) return undefined;
  const { slope, r2 } = trend(pts);
  const growth = slope * windowMin;
  console.log(
    `${label.padEnd(22)} slope ${(slope * 60).toFixed(3).padStart(7)} MB/h  → ${growth.toFixed(3).padStart(7)} MB over ${windowMin} min  (R² ${r2.toFixed(2)}, ${pts.length} samples, ${Math.min(...pts.map((p) => p[1])).toFixed(2)}–${Math.max(...pts.map((p) => p[1])).toFixed(2)} MB)`,
  );
  return { growth, r2 };
};
console.log(
  `\nafter ${WARMUP} min warm-up${MODE === 'external' ? '' : ` (collector batches received: ${batches})`}:`,
);
const heap = report('heap (all samples)', () => true, 'heapUsed');
if (MODE === 'cycle') report('heap (collector up)', (r) => r.collector === 'up', 'heapUsed');
if (MODE === 'cycle') report('heap (collector down)', (r) => r.collector === 'down', 'heapUsed');
report('rss (all samples)', () => true, 'rss');

if (OUT) console.log(`samples written to ${OUT}`);

const fail = heap && heap.growth >= MAX_GROWTH_MB && heap.r2 >= 0.5;
console.log(
  `\nresult: ${fail ? 'FAIL' : 'PASS'}: heap ${heap?.growth.toFixed(3)} MB over ${windowMin} min (R² ${heap?.r2.toFixed(2)}); fails at >= ${MAX_GROWTH_MB} MB with R² >= 0.5`,
);
if (CI && fail) process.exitCode = 1;
