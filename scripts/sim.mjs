// `pnpm sim` | `sim:run <scenario>` | `sim:list` | `sim:stop` | `sim:reset`: simulation mode
// on a simulated clock (docs/demo.md "Simulate weeks in minutes"). Uses the test Postgres
// (docker/docker-compose.test.yml, port 54329) and its `theirside_sim` database, never the
// `im` database the collector tests use.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOLDER_MESSAGE,
  PORT,
  ROOT,
  TEST_COMPOSE,
  bold,
  dim,
  dockerQuiet,
  fail,
  green,
  pnpm,
  portFree,
  requireDocker,
  run,
  waitForCollector,
  whoHolds,
} from './lib.mjs';

const SIM_DB = 'theirside_sim';
const TEST_DB = 'im';
const SCENARIOS = join(ROOT, 'examples/sim');
const ADMIN_TOKEN = process.env.THEIRSIDE_ADMIN_TOKEN ?? 'change-me-admin-token';

const [command, ...args] = process.argv.slice(2);

/** The port the collector will listen on (--port N; 0 = no dashboard). */
function portOf(argv) {
  const i = argv.indexOf('--port');
  return i >= 0 ? Number(argv[i + 1]) : Number(process.env.THEIRSIDE_PORT ?? PORT);
}

function testPostgresRunning() {
  const r = dockerQuiet([...TEST_COMPOSE, 'ps', '-q', '--status', 'running', 'postgres']);
  return r.code === 0 && r.stdout.trim() !== '';
}

/** sim:reset and sim:stop act on the test Postgres only; a custom database is the user's. */
function checkDefaultDatabase(what) {
  const url = process.env.THEIRSIDE_SIM_DATABASE_URL;
  if (!url) return;
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (u.port !== '54329' || !['127.0.0.1', 'localhost'].includes(u.hostname) || name !== SIM_DB)
    fail(
      `THEIRSIDE_SIM_DATABASE_URL points at ${u.hostname}:${u.port}/${name}; pnpm ${what} only handles ${SIM_DB} on the test Postgres. Manage that database yourself.`,
    );
}

async function startTestPostgres() {
  if (testPostgresRunning()) return;
  if (!(await portFree(54329)))
    fail(
      'Port 54329 (the test Postgres) is in use by something other than docker/docker-compose.test.yml: stop it first.',
    );
  console.log('Starting the test Postgres (docker/docker-compose.test.yml, port 54329)…');
  if ((await run('docker', [...TEST_COMPOSE, 'up', '-d', '--wait'])) !== 0)
    fail('The test Postgres did not start; see the docker output above.');
}

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

/** Build the dashboard the collector serves when its build is missing or older than its sources. */
async function ensureDashboard() {
  const built = join(ROOT, 'apps/collector/public/index.html');
  const sources = [
    'apps/dashboard/src',
    'apps/dashboard/index.html',
    'apps/dashboard/vite.config.ts',
    'apps/dashboard/package.json',
    'packages/design/tokens.json',
    'packages/design/src',
  ].map((p) => newestMtime(join(ROOT, p)));
  const builtAt = existsSync(built) ? statSync(built).mtimeMs : 0;
  if (builtAt && builtAt >= Math.max(...sources)) return;
  console.log(
    builtAt
      ? 'The dashboard build is older than its sources; rebuilding it…'
      : 'Building the dashboard (first time)…',
  );
  if ((await pnpm(['--filter', '@theirside/dashboard', 'build'])) !== 0)
    fail('The dashboard build failed; see the output above.');
}

async function prerequisites(port) {
  requireDocker();
  if (port !== 0) {
    const holder = await whoHolds(port);
    if (holder !== 'free') fail(HOLDER_MESSAGE[holder](port));
  }
  await startTestPostgres();
  if (port !== 0) await ensureDashboard();
}

/** The collector's own sim CLI (apps/collector/src/sim/cli.ts). */
function collectorSim(argv) {
  return pnpm(['--silent', '--filter', '@theirside/collector', 'sim', '--', ...argv]);
}

async function serve(argv) {
  const port = portOf(argv);
  await prerequisites(port);
  let exited = false;
  const done = collectorSim(['--serve', ...argv]).then((code) => {
    exited = true;
    return code;
  });
  if (port !== 0 && (await waitForCollector(port, 120_000, () => !exited)))
    console.log(`
${green('✔')} ${bold('Simulation running')} (simulated clock, simulation database ${SIM_DB})

  Open           ${bold(`http://localhost:${port}/#/simulation`)}
  Sign in        first visit: the setup page; enter the admin token ${bold(ADMIN_TOKEN)} and
                 create a local account (or "Use the admin token" on the sign-in page)
  Scenarios      load one on the page, or in another terminal: pnpm sim:run <name> ${dim('(stop this first)')}
  Stop           Ctrl-C here; pnpm sim:stop also stops its Postgres
`);
  process.exitCode = await done;
}

/** The scenario argument: the first one that is neither an option nor an option's value. */
function positional(argv) {
  return argv.find(
    (a, i) =>
      !a.startsWith('--') && !/^--(speed|seeded|port|database-url)$/.test(argv[i - 1] ?? ''),
  );
}

async function runScenario(argv) {
  const scenario = positional(argv);
  if (!scenario) {
    console.log(
      'usage: pnpm sim:run <scenario> [--speed 3600|max] [--from-empty] [--seeded DAYS] [--port 0]\n',
    );
    list();
    process.exit(1);
  }
  if (
    !scenario.endsWith('.yaml') &&
    !scenario.endsWith('.yml') &&
    !existsSync(join(SCENARIOS, `${scenario}.yaml`))
  )
    fail(
      `No scenario "${scenario}" in examples/sim. pnpm sim:list shows the ready-made ones; a path to a .yaml file works too.`,
    );
  await prerequisites(portOf(argv));
  process.exitCode = await collectorSim(argv);
}

/** The first sentence of a scenario's `description: >-` block. */
function summary(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return '';
  let text = lines[i].replace(/^description:\s*(>-?|\|-?)?\s*/, '');
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++)
    text += ' ' + lines[j].trim();
  text = text.trim().replace(/^['"]|['"]$/g, '');
  const first = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  // one line: long first sentences stop at their first clause, then lose their asides
  let short = first.length > 100 ? first.split(/[:;]\s/)[0] : first;
  if (short.length > 100) short = short.replace(/\s*\([^)]*\)/g, '');
  short = short.replace(/\.$/, '');
  return short.length > 100 ? short.slice(0, 97).trimEnd() + '…' : short;
}

function list() {
  const files = readdirSync(SCENARIOS)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  const width = Math.max(...files.map((f) => f.length - 5));
  console.log('Ready-made scenarios (examples/sim):\n');
  for (const f of files)
    console.log(`  ${bold(f.slice(0, -5).padEnd(width))}  ${summary(join(SCENARIOS, f))}`);
  console.log(`\nRun one: pnpm sim:run <name>; or load it on the Simulation page (pnpm sim).`);
}

async function simServerRunning() {
  return (await whoHolds(PORT)) === 'sim';
}

async function stop() {
  checkDefaultDatabase('sim:stop');
  requireDocker();
  if (await simServerRunning()) fail(HOLDER_MESSAGE.sim(PORT));
  if (!testPostgresRunning()) return console.log('The simulation Postgres is not running.');
  process.exitCode = await run('docker', [...TEST_COMPOSE, 'stop']);
  if (!process.exitCode)
    console.log(
      'Stopped. It is the test Postgres (data in memory): its databases are gone, and pnpm sim or pnpm sim:run starts it again.',
    );
}

function psql(db, sql) {
  return dockerQuiet([
    ...TEST_COMPOSE,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'theirside',
    '-d',
    db,
    '-tAc',
    sql,
  ]);
}

async function reset() {
  checkDefaultDatabase('sim:reset');
  requireDocker();
  if (await simServerRunning()) fail(HOLDER_MESSAGE.sim(PORT));
  if (!testPostgresRunning())
    return console.log(
      'Nothing to wipe: the test Postgres is not running (it keeps its data in memory).',
    );
  if (SIM_DB === TEST_DB) fail('refusing to drop the test database');
  const exists = psql('postgres', `SELECT 1 FROM pg_database WHERE datname = '${SIM_DB}'`);
  if (exists.code !== 0) fail(`Could not query the test Postgres: ${exists.stderr.trim()}`);
  if (exists.stdout.trim() !== '1')
    return console.log(`Nothing to wipe: there is no ${SIM_DB} database.`);
  // only a database marked as a simulation database (install_meta.simulation_db) is dropped
  const marked = psql(SIM_DB, `SELECT 1 FROM install_meta WHERE key = 'simulation_db'`);
  if (marked.stdout.trim() !== '1')
    fail(`${SIM_DB} is not marked as a simulation database; not dropping it. Check what it holds.`);
  const drop = psql('postgres', `DROP DATABASE ${SIM_DB}`);
  if (drop.code !== 0)
    fail(
      `Could not drop ${SIM_DB}: ${drop.stderr.trim()}\n  Is a pnpm sim:run with --port 0 still running?`,
    );
  console.log(
    `Wiped ${SIM_DB} (accounts, scenarios' data, everything); the next pnpm sim creates it empty.`,
  );
}

switch (command) {
  case 'serve':
    // `pnpm sim <scenario>` (without --serve) keeps running a scenario, as before
    if (positional(args) && !args.includes('--serve')) await runScenario(args);
    else await serve(args.filter((a) => a !== '--serve'));
    break;
  case 'run':
    await runScenario(args);
    break;
  case 'list':
    list();
    break;
  case 'stop':
    await stop();
    break;
  case 'reset':
    await reset();
    break;
  default:
    fail('usage: node scripts/sim.mjs serve|run|list|stop|reset');
}
