/**
 * `pnpm demo:seed` and the demo stacks' one-shot `demo-seed` service (the dev demo profile
 * and docker/compose.demo.yml): backfills demo data into DATABASE_URL (see src/demo/seed.ts
 * and docs/demo.md). With DEMO_ALERT_SINK_URL (+ DEMO_ALERT_SINK_SECRET) it also adds the
 * webhook alert channel into the chaos provider's sink.
 * Exits 0 when already seeded, 2 when the database is not a demo install.
 */
import { DemoSeedRefused, ensureDemoAlertSink, seedDemo } from './demo/seed.js';
import { createPgStorage } from './storage/postgres.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('demo-seed: DATABASE_URL is required');
  process.exit(1);
}
// the demo stacks: their app (and the dev stack's load generator) use a preset key (the
// dev profile's from docker/dev.env); without one the collector makes up its own and the
// demo stays empty
if (process.env.DEMO_STACK && !process.env.THEIRSIDE_API_KEY) {
  console.error(
    'demo-seed: refused: start the demo with the dev values: ' +
      'pnpm demo (docker compose --env-file docker/dev.env -f docker/docker-compose.yml --profile demo up --build)',
  );
  process.exit(2);
}
const { storage, pool } = createPgStorage({
  connectionString: url,
  caFile: process.env.THEIRSIDE_DATABASE_CA_FILE || undefined,
});
try {
  const t0 = Date.now();
  const r = await seedDemo(storage, { log: (m) => console.log(`demo-seed: ${m}`) });
  if (r.seeded) console.log(`demo-seed: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const sinkUrl = process.env.DEMO_ALERT_SINK_URL;
  if (sinkUrl) {
    const sink = { url: sinkUrl, secret: process.env.DEMO_ALERT_SINK_SECRET ?? '' };
    if (await ensureDemoAlertSink(storage, sink))
      console.log(`demo-seed: alert channel → ${sinkUrl}`);
  }
} catch (err) {
  if (err instanceof DemoSeedRefused) {
    console.error(`demo-seed: refused: ${err.message}`);
    process.exitCode = 2;
  } else throw err;
} finally {
  await pool.end();
}
