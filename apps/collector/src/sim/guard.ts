/**
 * Simulation databases (docs/demo.md "Simulate weeks in minutes"): simulation mode
 * writes weeks of synthetic traffic and resets tables freely, so it runs only on a
 * database marked as a simulation database (`install_meta.simulation_db`). An empty
 * database is marked on its first start in simulation mode; one holding any other
 * data is refused. A normal collector refuses a marked database, so simulation data
 * never mixes with real data.
 */
import type pg from 'pg';

export const SIM_META_KEY = 'simulation_db';

/** Tables whose rows mean the database is in use (any row: not empty). */
const IN_USE = ['orgs', 'users', 'rollups_1m', 'rollups_inbound_1m', 'events', 'incidents'];

/** Product data a reset clears; accounts, keys, channels and settings stay. */
export const RESET_TABLES = [
  'events',
  'rollups_1m',
  'rollups_inbound_1m',
  'incident_endpoints',
  'incidents',
  'alert_deliveries',
  'baselines',
  'inbound_baselines',
  'webhook_sources',
  'webhook_candidate_days',
  'webhook_candidates',
  'sdk_processes',
  'sdk_instances',
  'service_templates',
  'usage_daily',
  'providers',
];

export class SimGuardError extends Error {}

async function isMarked(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  const { rows } = await db.query(`SELECT value FROM install_meta WHERE key = $1`, [SIM_META_KEY]);
  return rows.length > 0;
}

async function inUse(db: pg.Pool | pg.PoolClient): Promise<string[]> {
  const used: string[] = [];
  for (const t of IN_USE) {
    const { rows } = await db.query(`SELECT EXISTS (SELECT 1 FROM ${t}) AS any`);
    if (rows[0]?.any) used.push(t);
  }
  return used;
}

/**
 * Run after migrations, before anything else writes. Simulation mode: accept a
 * marked database, mark an empty one, refuse anything else. Normal mode: refuse a
 * marked one.
 */
export async function checkSimDatabase(db: pg.Pool, sim: boolean): Promise<'marked' | 'ok'> {
  const marked = await isMarked(db);
  if (!sim) {
    if (marked)
      throw new SimGuardError(
        'this database is a simulation database (synthetic data); start with THEIRSIDE_SIM=1, or point DATABASE_URL at another database',
      );
    return 'ok';
  }
  if (marked) return 'ok';
  const used = await inUse(db);
  if (used.length > 0)
    throw new SimGuardError(
      `THEIRSIDE_SIM=1 refuses this database: it is not a simulation database and holds data (${used.join(', ')}). Use an empty database (it is marked on first start), e.g. one named theirside_sim.`,
    );
  await db.query(
    `INSERT INTO install_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [SIM_META_KEY, new Date().toISOString()],
  );
  return 'marked';
}

/** Clear the product data of a simulation database (refuses an unmarked one). */
export async function resetSimDatabase(db: pg.Pool): Promise<void> {
  if (!(await isMarked(db)))
    throw new SimGuardError('refusing to reset a database that is not a simulation database');
  await db.query(`TRUNCATE ${RESET_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  // times written by jobs and migrations on the real clock would sit in the simulated
  // future or past: slotted job runs, the status-mix start, one-time regroups, the demo seed
  await db.query(
    `DELETE FROM install_meta
      WHERE key LIKE 'job:%' OR key LIKE 'catalog_regroup:%' OR key IN ('status_mix_since', 'demo_seeded_at')`,
  );
}
