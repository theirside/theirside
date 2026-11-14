import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { parse, parseIntoClientConfig } from 'pg-connection-string';

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

/** The self-hosting docs' section on database TLS. */
export const DATABASE_TLS_DOCS = 'https://theirside.dev/docs/self-hosting#database-tls';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const RDS_HOST = /\.rds\.amazonaws\.com(\.cn)?$/i;
/** sslmode values that don't verify the server certificate (in PostgreSQL's own terms). */
const UNVERIFIED = new Set(['disable', 'allow', 'prefer', 'require', 'no-verify']);

export interface DatabaseTlsStatus {
  /** The database host from DATABASE_URL (never the credentials). */
  host: string;
  sslmode: string | null;
  /** localhost, a Unix socket or a single-label name (`postgres` on a Compose network). */
  local: boolean;
  /** The server certificate is verified: `verify-full`/`verify-ca`, or a CA file is set. */
  verified: boolean;
  /** For a remote, unverified connection: one line saying so, with the fix. */
  warning: string | null;
}

/**
 * Startup check (warn, never block): a database on another machine should be reached with
 * the server certificate verified. Local only: localhost, 127.0.0.1, ::1, a Unix socket,
 * single-label names; everything else, private IPs included, counts as remote.
 */
export function databaseTlsStatus(databaseUrl: string, caFile?: string): DatabaseTlsStatus {
  let host = '';
  let sslmode: string | null = null;
  try {
    const c = parse(databaseUrl) as { host?: string | null; sslmode?: string };
    host = c.host ?? '';
    sslmode = typeof c.sslmode === 'string' && c.sslmode ? c.sslmode.toLowerCase() : null;
  } catch {
    // an unparsable URL fails at connect with its own error; nothing to add here
  }
  const name = host.toLowerCase();
  const local =
    name === '' ||
    name.startsWith('/') ||
    LOCAL_HOSTS.has(name) ||
    (!name.includes('.') && !name.includes(':'));
  const verified =
    sslmode === 'verify-full' ||
    sslmode === 'verify-ca' ||
    (!!caFile && sslmode !== 'disable' && sslmode !== 'no-verify');
  const unverified = sslmode === null || UNVERIFIED.has(sslmode);
  const warning =
    local || verified || !unverified
      ? null
      : `The database connection to ${host} is not verified (sslmode=${sslmode ?? 'not set'}): its TLS certificate isn't checked, so anything on the network path could pose as the database. Fix: add sslmode=verify-full to DATABASE_URL and ${
          RDS_HOST.test(host)
            ? `set THEIRSIDE_DATABASE_CA_FILE=${RDS_CA_BUNDLE_PATH} (included in the image)`
            : "set THEIRSIDE_DATABASE_CA_FILE to your provider's CA file (not needed when its certificate comes from a public CA)"
        }. ${DATABASE_TLS_DOCS}`;
  return { host, sslmode, local, verified, warning };
}
