// `pnpm demo` | `demo:logs` | `demo:stop` | `demo:reset`: the demo stack in Docker, on the
// real clock (docs/demo.md).
import {
  DEMO_COMPOSE,
  HOLDER_MESSAGE,
  PORT,
  bold,
  devEnv,
  dim,
  fail,
  green,
  portFree,
  requireDocker,
  run,
  whoHolds,
} from './lib.mjs';

const command = process.argv[2];

async function up() {
  requireDocker();
  const holder = await whoHolds(PORT);
  if (holder !== 'free' && holder !== 'demo') fail(HOLDER_MESSAGE[holder](PORT));
  for (const [port, what] of [
    [4010, 'chaos provider'],
    [3000, 'demo app'],
  ]) {
    if (holder !== 'demo' && !(await portFree(port)))
      fail(`Port ${port} (the demo's ${what}) is in use by another program: stop it first.`);
  }
  console.log(
    holder === 'demo'
      ? 'The demo is already running; bringing it up to date…'
      : 'Starting the demo (the first build takes a few minutes)…',
  );
  const code = await run('docker', [...DEMO_COMPOSE, 'up', '-d', '--build', '--wait']);
  if (code !== 0)
    fail(
      'The demo did not start. See what failed with pnpm demo:logs (or docker compose ps), then pnpm demo:stop.',
    );
  const token = devEnv().THEIRSIDE_ADMIN_TOKEN;
  console.log(`
${green('✔')} ${bold('Demo running')} (real clock, live traffic from the load generator)

  Dashboard      ${bold(`http://localhost:${PORT}`)}
                 first visit: the setup page; enter the admin token, then a local account
  Admin token    ${bold(token)}
  Demo app       http://localhost:3000
  Chaos rules    http://localhost:4010/__chaos      ${dim('break an endpoint: POST /__chaos/rules')}
  Webhooks       http://localhost:4010/__webhooks   ${dim('PUT {"mode":"silent|rejected|slow|late|normal"}')}
  Alerts sink    http://localhost:4010/__alerts

  Examples:      ${dim(`curl -s -X POST localhost:4010/__chaos/rules -d '{"path":"/v2/cards/:id/activate","method":"POST","errorRate":0.4,"errorStatus":503,"durationSeconds":360}'`)}
                 ${dim(`curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"silent"}'`)}
  More:          docs/demo.md

  pnpm demo:logs     follow the logs
  pnpm demo:stop     stop, keep the data
  pnpm demo:reset    stop and wipe the database
`);
}

async function main() {
  switch (command) {
    case 'up':
      return up();
    case 'logs':
      requireDocker();
      process.exitCode = await run('docker', [...DEMO_COMPOSE, 'logs', '-f', '--tail', '100']);
      return;
    case 'stop':
      requireDocker();
      process.exitCode = await run('docker', [...DEMO_COMPOSE, 'down']);
      if (!process.exitCode)
        console.log('Demo stopped; its data is kept (pnpm demo:reset wipes it).');
      return;
    case 'reset':
      requireDocker();
      process.exitCode = await run('docker', [...DEMO_COMPOSE, 'down', '-v']);
      if (!process.exitCode)
        console.log(
          'Demo stopped and its database wiped; pnpm demo starts it fresh (and seeds a week of history).',
        );
      return;
    default:
      fail('usage: node scripts/demo.mjs up|logs|stop|reset');
  }
}

await main();
