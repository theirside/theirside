import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';

/** Where the image keeps AWS RDS's global CA bundle (docker/certs, Dockerfile.collector). */
export const RDS_CA_BUNDLE_PATH = '/app/certs/rds-global-bundle.pem';

/**
 * Connection settings for the pool. Without a CA file, `DATABASE_URL` is used as it is
 * (its `sslmode`, `sslrootcert`… apply). With `THEIRSIDE_DATABASE_CA_FILE`, TLS is on and the
 * server certificate must chain to a CA in that file and match the host (`verify-full`).
 * node-postgres lets the connection string's TLS settings override an explicit `ssl`
 * option, so the URL is parsed here and the result passed without it.
 */
export function pgConnectionConfig(
  databaseUrl: string,
  caFile?: string,
): Pick<pg.PoolConfig, 'connectionString'> | pg.ClientConfig {
  if (!caFile) return { connectionString: databaseUrl };
  const parsed = parseIntoClientConfig(databaseUrl);
  const ssl = parsed.ssl;
  if (ssl === false)
    throw new Error(
      'THEIRSIDE_DATABASE_CA_FILE is set but DATABASE_URL has sslmode=disable: use sslmode=verify-full',
    );
  if (typeof ssl === 'object' && ssl.rejectUnauthorized === false)
    throw new Error(
      'THEIRSIDE_DATABASE_CA_FILE is set but DATABASE_URL has sslmode=no-verify, which skips the certificate check: use sslmode=verify-full',
    );
  return {
    ...parsed,
    ssl: {
      ...(typeof ssl === 'object' ? ssl : {}),
      ca: readCaFile(caFile),
      rejectUnauthorized: true,
    },
  };
}

/** The PEM text of a CA file; a clear error when it is missing or holds no certificate. */
export function readCaFile(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `THEIRSIDE_DATABASE_CA_FILE: cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? String(err)})`,
      { cause: err },
    );
  }
  if (!text.includes('-----BEGIN CERTIFICATE-----'))
    throw new Error(`THEIRSIDE_DATABASE_CA_FILE: ${path} holds no PEM certificate`);
  return text;
}
