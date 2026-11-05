import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** migrations/ sits next to src/ and dist/ in the package. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const LOCK_KEY = 'theirside:migrate';

/**
 * Tiny migration runner: applies migrations/NNN_name.sql in order, each in its
 * own transaction, recorded in schema_migrations. An advisory lock makes
 * concurrent replicas wait for each other instead of racing.
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r: { name: string }) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(
        new URL(file, `file://${dir.endsWith('/') ? dir : dir + '/'}`),
        'utf8',
      );
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
