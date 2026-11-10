/**
 * `pnpm demo:seed` and the demo profile's one-shot `demo-seed` service:
 * backfills demo data into DATABASE_URL (see src/demo/seed.ts and docs/demo.md).
 * Exits 0 when already seeded, 2 when the database is not a demo install.
 */
import { DemoSeedRefused, seedDemo } from './demo/seed.js';
import { createPgStorage } from './storage/postgres.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('demo-seed: DATABASE_URL is required');
  process.exit(1);
}
// the compose demo profile: its app and load generator use the key and admin token from
// docker/dev.env; without them the collector makes up its own and the demo stays empty
if (process.env.DEMO_STACK && !process.env.THEIRSIDE_API_KEY) {
  console.error(
    'demo-seed: refused: start the demo with the dev values: ' +
      'docker compose --env-file docker/dev.env -f docker/docker-compose.yml --profile demo up --build',
  );
  process.exit(2);
}
const { storage, pool } = createPgStorage({ connectionString: url });
try {
  const t0 = Date.now();
  const r = await seedDemo(storage, { log: (m) => console.log(`demo-seed: ${m}`) });
  if (r.seeded) console.log(`demo-seed: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (err) {
  if (err instanceof DemoSeedRefused) {
    console.error(`demo-seed: refused: ${err.message}`);
    process.exitCode = 2;
  } else throw err;
} finally {
  await pool.end();
}
