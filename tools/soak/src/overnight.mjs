// Unattended long soak: three variants of run.mjs IN PARALLEL on the same
// machine, so they share the same conditions, then SUMMARY.md (summary.mjs).
//   (a) SDK on, real collector (--endpoint, --api-key; must answer /v1/sdk-config)
//   (b) SDK on, collector unreachable (a closed port)
//   (c) SDK off (control)
//
//   node src/overnight.mjs --out-dir results/2026-11-04 [--hours 8] [--sample-seconds 30]
//        [--warmup 10] [--rps 300] [--endpoint http://localhost:4318] [--api-key KEY]
//
// Writes into --out-dir: one CSV and one log per variant, pids.json, and
// SUMMARY.md when the runs end. SIGTERM (kill <pid of this process>) stops
// all three early; they still report and SUMMARY.md covers what ran.
// Start it detached with tools/soak/overnight.sh.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, VARIANTS } from './summary.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const OUT_DIR = path.resolve(opt('out-dir', `results/${new Date().toISOString().slice(0, 10)}`));
const HOURS = Number(opt('hours', 8));
const SAMPLE_SECONDS = Number(opt('sample-seconds', 30));
const WARMUP = Number(opt('warmup', 10));
const RPS = opt('rps', '300');
const ENDPOINT = opt('endpoint', 'http://localhost:4318');
const API_KEY = opt(
  'api-key',
  process.env.THEIRSIDE_API_KEY ?? 'tsd_live_localdemo0000000000000000',
);

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

// the real collector must be current: a 404 on sdk-config would turn discovery off in (a)
async function preflight() {
  const ready = await fetch(`${ENDPOINT}/readyz`).catch((e) => ({ ok: false, status: e.message }));
  if (!ready.ok) throw new Error(`collector not ready at ${ENDPOINT}/readyz (${ready.status})`);
  const cfg = await fetch(`${ENDPOINT}/v1/sdk-config`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  if (cfg.status !== 200)
    throw new Error(
      `GET ${ENDPOINT}/v1/sdk-config answered ${cfg.status} (401: wrong --api-key; 404: collector older than auto-discovery)`,
    );
}

await preflight();
mkdirSync(OUT_DIR, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const common = [
  '--hours',
  String(HOURS),
  '--sample-seconds',
  String(SAMPLE_SECONDS),
  '--warmup',
  String(WARMUP),
  '--rps',
  RPS,
];
const args = {
  a: ['--collector', 'external', '--endpoint', ENDPOINT, '--api-key', API_KEY],
  b: ['--collector', 'down'],
  c: ['--collector', 'down', '--no-sdk'],
};

const children = VARIANTS.map((v) => {
  const logFile = path.join(OUT_DIR, v.file.replace(/\.csv$/, '.log'));
  const fd = openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [path.join(here, 'run.mjs'), ...common, ...args[v.id], '--out', path.join(OUT_DIR, v.file)],
    { stdio: ['ignore', fd, fd] },
  );
  log(`started ${v.label}: pid ${child.pid}, log ${logFile}`);
  return { v, child, exited: new Promise((r) => child.once('exit', (code) => r(code))) };
});

writeFileSync(
  path.join(OUT_DIR, 'pids.json'),
  JSON.stringify(
    {
      orchestrator: process.pid,
      variants: Object.fromEntries(children.map(({ v, child }) => [v.id, child.pid])),
      startedAt: new Date().toISOString(),
      hours: HOURS,
    },
    null,
    2,
  ) + '\n',
);

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(sig, () => {
    if (sig === 'SIGHUP') return; // terminal closed: keep running (nohup also covers this)
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping the three runs early; SUMMARY.md will cover what ran`);
    for (const { child } of children) child.kill('SIGTERM');
  });

const codes = await Promise.all(children.map((c) => c.exited));
children.forEach(({ v }, i) => log(`${v.label} exited with ${codes[i]}`));
const r = summarize(OUT_DIR, { warmupMin: WARMUP, plannedHours: HOURS });
log(`${r.ok ? 'OK for production' : 'needs investigation'}: ${r.summaryPath}`);
for (const reason of r.reasons) log(`  - ${reason}`);
