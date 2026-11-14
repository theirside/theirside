import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { schedulerJobs } from './jobs.js';
import { Scheduler } from './modules/scheduler/scheduler.js';
import { buildApp } from './server.js';
import { migrate } from './storage/migrate.js';
import { databaseTlsStatus } from './storage/pg-connection.js';
import { createPgStorage } from './storage/postgres.js';
import { SIM_DEFAULT_START, attachSim } from './sim/app.js';
import { SimClock } from './sim/clock.js';
import { checkSimDatabase } from './sim/guard.js';
import { systemClock } from './util/clock.js';

async function waitForDatabase(ping: () => Promise<void>, log: (m: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ping();
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      log(`database not reachable yet (${(err as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * attempt)));
    }
  }
}

async function main() {
  const config = loadConfig();
  const { storage, pool } = createPgStorage({
    connectionString: config.databaseUrl,
    caFile: config.databaseCaFile,
  });
  const app0Log = (m: string) => console.log(JSON.stringify({ level: 'info', msg: m }));
  await waitForDatabase(() => storage.ping(), app0Log);
  const applied = await migrate(pool);
  if (applied.length) app0Log(`applied migrations: ${applied.join(', ')}`);
  // simulation databases and real ones never mix (docs/demo.md "Simulate weeks in minutes")
  if ((await checkSimDatabase(pool, config.sim)) === 'marked')
    app0Log('simulation mode: marked this empty database as a simulation database');

  // simulation mode: product time is the simulated clock; accounts and credentials stay on real time
  const simClock = config.sim ? new SimClock(SIM_DEFAULT_START) : undefined;
  const ctx = createContext(config, storage, {
    log: app0Log,
    ...(simClock ? { clock: simClock, wallClock: systemClock } : {}),
  });
  const boot = await bootstrap(storage, {
    apiKey: config.bootstrapApiKey,
    generateKey: config.zeroConfig,
    orgName: config.bootstrapOrgName,
    projectName: config.bootstrapProjectName,
    entitlements: ctx.entitlements,
  });
  if (boot.created) app0Log(`bootstrapped org ${boot.orgId} / project ${boot.projectId}`);
  // the key itself is never logged: the first account sees it on the "Connect your app" screen
  if (boot.generatedKey) app0Log('generated the project API key (shown after the first sign-in)');
  await storage.events.ensurePartitions(ctx.clock.now(), config.partitionsAhead + 1);

  const app = await buildApp(ctx, { logger: { level: config.logLevel } });
  // database TLS: one line when a remote database isn't verified (never blocks startup)
  const databaseTls = databaseTlsStatus(config.databaseUrl, config.databaseCaFile);
  if (databaseTls.warning) app.log.warn(databaseTls.warning);
  if (config.trustProxy === true)
    app.log.warn(
      'THEIRSIDE_TRUST_PROXY=true believes X-Forwarded-For from any address: a client that reaches the ' +
        "collector directly can pick the IP its sign-in attempts are counted against. Set the load balancers' CIDRs instead.",
    );
  if (!config.publicPathsOnly && config.zeroConfig) {
    const token = await ctx.accounts.issueSetupToken();
    if (token) {
      const where = config.publicUrl ?? `http://localhost:${config.port}`;
      app.log.warn(`Open ${where}/setup?token=${token} to create the first account`);
    }
  } else if (!config.publicPathsOnly) {
    const code = await ctx.accounts.issueSetupCode();
    if (code) {
      const where = config.publicUrl ?? `http://localhost:${config.port}`;
      app.log.warn(
        `No user accounts yet. Open ${where}/#/setup and create the first admin with setup code ${code} ` +
          `(valid 24 h, or use THEIRSIDE_ADMIN_TOKEN).`,
      );
    }
  }
  // 2FA secrets: re-encrypt under a rotated THEIRSIDE_SECRET_KEY, and say when codes can't be checked
  const totp = await ctx.accounts.twoFactor.rotate();
  if (totp.rotated)
    app.log.info(`re-encrypted ${totp.rotated} 2FA secret(s) with THEIRSIDE_SECRET_KEY`);
  const withTotp = (await storage.auth.listTotpSecrets()).filter((r) => r.secretEnc).length;
  if (withTotp && (!config.secretKey || totp.unreadable))
    app.log.warn(
      `${totp.unreadable || withTotp} user(s) have two-factor sign-in, but their secrets can't be decrypted: ` +
        `THEIRSIDE_SECRET_KEY is ${config.secretKey ? 'not the key they were saved with (add the old key to THEIRSIDE_SECRET_KEY_PREVIOUS)' : 'not set'}. ` +
        `They can only sign in with recovery codes until it is fixed.`,
    );
  const info = (m: string) => app.log.info(m);
  const scheduler = new Scheduler(
    storage,
    ctx.clock,
    schedulerJobs(ctx, config, info),
    app.log,
    config.schedulerIntervalMs,
  );

  // simulation mode: the engine steps the jobs one simulated minute at a time
  const sim = simClock ? await attachSim(app, ctx, pool, config, simClock, { log: info }) : null;
  if (sim)
    app.log.warn(
      'SIMULATION MODE: synthetic data on a simulated clock (Simulation page, /__sim API)',
    );

  await app.listen({ host: config.host, port: config.port });
  // a public-paths-only instance serves the status page and nothing else
  if (!sim && config.schedulerEnabled && !config.publicPathsOnly) scheduler.start();

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    await scheduler.stop();
    await sim?.engine.stop();
    await app.close();
    await storage.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: 'collector failed to start',
      error: String(err?.stack ?? err),
    }),
  );
  process.exit(1);
});
