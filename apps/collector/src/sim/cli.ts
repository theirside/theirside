/**
 * `pnpm sim:run <scenario> [--speed 3600|max] [--from-empty] [--seeded DAYS] [--port 4318]`
 * `pnpm sim [--serve] [scenario]`: only start the collector in simulation mode for the
 * Simulation page (the scenario, if given, is loaded and paused); runs until Ctrl-C.
 * (docs/demo.md "Simulate weeks in minutes"). Starts a collector in simulation mode
 * on the simulation database (created and marked if missing; reset by the run),
 * runs the scenario on the simulated clock, prints the timeline of faults,
 * incidents and alerts as they happen, and ends with the expectations' results:
 * exit code 1 when one fails. While it runs, the dashboard on --port shows
 * everything (sign in with the admin token).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { buildApp } from '../server.js';
import { migrate } from '../storage/migrate.js';
import { createPgStorage } from '../storage/postgres.js';
import { systemClock } from '../util/clock.js';
import { SIM_DEFAULT_START, attachSim } from './app.js';
import { SimClock, parseSpeed, type Speed } from './clock.js';
import { checkSimDatabase } from './guard.js';
import { readScenario, scenarioDirs } from './routes.js';
import { formatTime, parseScenarioYaml } from './scenario.js';

export const DEFAULT_SIM_DATABASE_URL = 'postgres://theirside:im@127.0.0.1:54329/theirside_sim';

interface Args {
  scenario: string;
  speed: Speed;
  history: { mode: 'empty' } | { mode: 'seeded'; days: number } | null;
  port: number;
  databaseUrl: string;
  quiet: boolean;
  serve: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    scenario: '',
    speed: 'max',
    history: null,
    port: Number(process.env.THEIRSIDE_PORT ?? 4318),
    databaseUrl: process.env.THEIRSIDE_SIM_DATABASE_URL ?? DEFAULT_SIM_DATABASE_URL,
    quiet: false,
    serve: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (v === '--speed') {
      const s = parseSpeed(next());
      if (s === null) throw new Error('--speed: a positive number or max');
      a.speed = s;
    } else if (v === '--from-empty') a.history = { mode: 'empty' };
    else if (v === '--seeded') a.history = { mode: 'seeded', days: Number(next()) };
    else if (v === '--port') a.port = Number(next());
    else if (v === '--database-url') a.databaseUrl = next();
    else if (v === '--quiet') a.quiet = true;
    else if (v === '--serve') a.serve = true;
    else if (v === '--') continue;
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else a.scenario = v;
  }
  if (!a.scenario && !a.serve)
    throw new Error(
      'usage: pnpm sim:run <scenario name or file> [--speed 3600|max] [--from-empty] [--seeded DAYS] [--port 4318]',
    );
  return a;
}

/** Create the simulation database if the server has none by that name. */
async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error(`unexpected database name "${name}"`);
  u.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function loadScenarioText(ref: string): Promise<string> {
  if (existsSync(ref)) return readFile(ref, 'utf8');
  const named = await readScenario(scenarioDirs(), ref);
  if (named === null) throw new Error(`no scenario "${ref}" (a file, or a name in examples/sim)`);
  return named;
}

const color = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const parsed = args.scenario ? parseScenarioYaml(await loadScenarioText(args.scenario)) : null;
  await ensureDatabase(args.databaseUrl);
  const env = {
    THEIRSIDE_BOOTSTRAP_API_KEY: 'tsd_live_localdemo0000000000000000',
    THEIRSIDE_ADMIN_TOKEN: 'change-me-admin-token',
    THEIRSIDE_LOG_LEVEL: 'warn',
    ...process.env,
    DATABASE_URL: args.databaseUrl,
    THEIRSIDE_SIM: '1',
    THEIRSIDE_PORT: String(args.port),
  };
  const config = loadConfig(env);
  const { storage, pool } = createPgStorage({ connectionString: config.databaseUrl });
  if (process.env.THEIRSIDE_SIM_PROFILE === '1') countQueries(pool);
  await migrate(pool);
  await checkSimDatabase(pool, true);
  const clock = new SimClock(SIM_DEFAULT_START);
  const ctx = createContext(config, storage, { clock, wallClock: systemClock });
  await bootstrap(storage, {
    apiKey: config.bootstrapApiKey,
    generateKey: false,
    orgName: config.bootstrapOrgName,
    projectName: config.bootstrapProjectName,
    entitlements: ctx.entitlements,
  });
  const app = await buildApp(ctx, { logger: { level: config.logLevel } });
  const start = parsed ? Date.parse(parsed.scenario.start) : SIM_DEFAULT_START;
  const { engine } = await attachSim(app, ctx, pool, config, clock, {
    log: (m) => {
      if (!args.quiet && !m.startsWith('incident ')) console.log(color(90, `  ${m}`));
    },
    onEvent: (e) => {
      if (args.quiet) return;
      const tag =
        e.type === 'fault_start' || e.type === 'fault_end'
          ? color(33, 'FAULT ')
          : e.type === 'alert'
            ? color(36, 'ALERT ')
            : e.type === 'resolved'
              ? color(32, 'OK    ')
              : color(31, 'INCID ');
      console.log(`${formatTime(e.at, start).padEnd(14)} ${tag} ${e.text}`);
    },
  });
  if (args.port > 0) await app.listen({ host: config.host, port: args.port });
  if (args.serve || !parsed) {
    if (parsed) await engine.load(parsed.scenario, args.history ? { history: args.history } : {});
    console.log(
      `Simulation mode on http://localhost:${args.port}/#/simulation (sign in with the admin token: ${config.adminToken}). Ctrl-C to stop.`,
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await engine.stop();
    await app.close();
    await storage.close();
    return 0;
  }
  const t0 = Date.now();
  console.log(
    `Simulating "${parsed.scenario.name}" (${parsed.scenario.duration}) at ${args.speed === 'max' ? 'max speed' : `${args.speed}×`}` +
      (args.port > 0
        ? `; dashboard: http://localhost:${args.port} (admin token: ${config.adminToken})`
        : ''),
  );
  await engine.load(parsed.scenario, args.history ? { history: args.history } : {});
  engine.setSpeed(args.speed);
  engine.play();
  for (;;) {
    const s = await engine.state();
    if (s.status === 'finished' || s.error) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const s = await engine.state();
  const results = s.expectations;
  console.log(
    `\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s real time${s.error ? ` (stopped: ${s.error})` : ''}.`,
  );
  for (const r of results)
    console.log(
      `${r.status === 'pass' ? color(32, 'PASS') : r.status === 'fail' ? color(31, 'FAIL') : color(33, 'OPEN')}  ${r.label}: ${r.detail}`,
    );
  const failed = results.filter((r) => r.status !== 'pass').length;
  console.log(
    results.length === 0
      ? 'No expectations.'
      : failed
        ? `${failed} of ${results.length} expectation(s) not met.`
        : `All ${results.length} expectation(s) met.`,
  );
  await engine.stop();
  await app.close();
  await storage.close();
  return s.error || failed ? 1 : 0;
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]))
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error((err as Error).message);
      process.exit(2);
    },
  );

/** THEIRSIDE_SIM_PROFILE=1: count statements per kind (first words), printed on exit. */
function countQueries(_pool: pg.Pool): void {
  const counts = new Map<string, { n: number; ms: number }>();
  const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const q = proto.query;
  proto.query = function (this: unknown, ...a: unknown[]) {
    const text = typeof a[0] === 'string' ? a[0] : String((a[0] as { text?: string })?.text ?? '?');
    const key = text.replace(/\s+/g, ' ').trim().slice(0, 70);
    const t0 = performance.now();
    const cb = a.at(-1);
    if (typeof cb === 'function')
      a[a.length - 1] = (...r: unknown[]) => {
        const c = counts.get(key) ?? { n: 0, ms: 0 };
        c.n++;
        c.ms += performance.now() - t0;
        counts.set(key, c);
        return (cb as (...x: unknown[]) => unknown)(...r);
      };
    const res = q.apply(this, a);
    if (typeof cb === 'function') return res;
    const done = () => {
      const c = counts.get(key) ?? { n: 0, ms: 0 };
      c.n++;
      c.ms += performance.now() - t0;
      counts.set(key, c);
    };
    if (res && typeof (res as Promise<unknown>).then === 'function')
      (res as Promise<unknown>).then(done, done);
    return res;
  };
  process.on('exit', () => {
    const all = [...counts];
    const total = all.reduce((x, [, v]) => x + v.ms, 0);
    const n = all.reduce((x, [, v]) => x + v.n, 0);
    console.log(`${n} statements, ${total.toFixed(0)} ms`);
    for (const [k, v] of all.sort((x, y) => y[1].ms - x[1].ms).slice(0, 30))
      console.log(`${String(v.n).padStart(7)} ${v.ms.toFixed(0).padStart(7)} ms  ${k}`);
  });
}
