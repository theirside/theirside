import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import {
  discoveryDigestJob,
  endpointMergeJob,
  templateMergeJob,
} from './modules/discovery/jobs.js';
import { catalogRegroupJob } from './modules/discovery/regroup.js';
import { alertJob, incidentJob } from './modules/incidents/job.js';
import { partitionJob, rollupRetentionJob } from './modules/scheduler/maintenance.js';
import { Scheduler } from './modules/scheduler/scheduler.js';
import { buildApp } from './server.js';
import { migrate } from './storage/migrate.js';
import { createPgStorage } from './storage/postgres.js';

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
  const { storage, pool } = createPgStorage({ connectionString: config.databaseUrl });
  const app0Log = (m: string) => console.log(JSON.stringify({ level: 'info', msg: m }));
  await waitForDatabase(() => storage.ping(), app0Log);
  const applied = await migrate(pool);
  if (applied.length) app0Log(`applied migrations: ${applied.join(', ')}`);

  const ctx = createContext(config, storage, { log: app0Log });
  const boot = await bootstrap(storage, {
    apiKey: config.bootstrapApiKey,
    orgName: config.bootstrapOrgName,
    projectName: config.bootstrapProjectName,
    entitlements: ctx.entitlements,
  });
  if (boot.created) app0Log(`bootstrapped org ${boot.orgId} / project ${boot.projectId}`);
  await storage.events.ensurePartitions(ctx.clock.now(), config.partitionsAhead + 1);

  const app = await buildApp(ctx, { logger: { level: config.logLevel } });
  if (config.trustProxy === true)
    app.log.warn(
      'THEIRSIDE_TRUST_PROXY=true believes X-Forwarded-For from any address: a client that reaches the ' +
        "collector directly can pick the IP its sign-in attempts are counted against. Set the load balancers' CIDRs instead.",
    );
  if (!config.publicPathsOnly) {
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
    [
      partitionJob(
        storage,
        { ahead: config.partitionsAhead, rawRetentionDays: config.rawRetentionDays },
        info,
      ),
      incidentJob(storage, ctx.alerts, { publicUrl: config.publicUrl, log: info }),
      alertJob(ctx.alerts),
      discoveryDigestJob(storage, ctx.alerts, { publicUrl: config.publicUrl, log: info }),
      catalogRegroupJob(storage, ctx.directory.catalog, info),
      templateMergeJob(storage, info),
      endpointMergeJob(storage, ctx.directory.catalog.entries, info),
      rollupRetentionJob(storage, ctx.entitlements, {
        rollupRetentionDays: config.rollupRetentionDays,
      }),
    ],
    app.log,
    config.schedulerIntervalMs,
  );

  await app.listen({ host: config.host, port: config.port });
  // a public-paths-only instance serves the status page and nothing else
  if (config.schedulerEnabled && !config.publicPathsOnly) scheduler.start();

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    await scheduler.stop();
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
