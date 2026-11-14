import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { pgConnectionConfig } from '../src/storage/pg-connection.js';

/**
 * THEIRSIDE_DATABASE_CA_FILE: the database's certificate is verified against a custom CA
 * (verify-full). The end-to-end check against a Postgres with a self-signed certificate is
 * docker/database-tls-check.sh (CI job "Database TLS").
 */
const bundle = path.resolve(import.meta.dirname, '../../../docker/certs/rds-global-bundle.pem');
const url = 'postgres://ts:secret@db.example.test:5432/theirside';

describe('pgConnectionConfig', () => {
  it('without a CA file, DATABASE_URL is used as it is', () => {
    expect(pgConnectionConfig(`${url}?sslmode=no-verify`)).toEqual({
      connectionString: `${url}?sslmode=no-verify`,
    });
  });

  it('with a CA file: TLS on, that CA, the certificate checked, no connection string', () => {
    for (const u of [`${url}?sslmode=verify-full`, url]) {
      const c = pgConnectionConfig(u, bundle) as Record<string, unknown> & {
        ssl: { ca: string; rejectUnauthorized: boolean };
      };
      expect(c.connectionString).toBeUndefined();
      expect(c).toMatchObject({
        host: 'db.example.test',
        port: 5432,
        user: 'ts',
        password: 'secret',
        database: 'theirside',
      });
      expect(c.ssl.rejectUnauthorized).toBe(true);
      expect(c.ssl.ca).toContain('-----BEGIN CERTIFICATE-----');
    }
  });

  it('refuses a CA file with sslmode=disable or no-verify', () => {
    expect(() => pgConnectionConfig(`${url}?sslmode=disable`, bundle)).toThrow(/sslmode=disable/);
    expect(() => pgConnectionConfig(`${url}?sslmode=no-verify`, bundle)).toThrow(
      /skips the certificate check/,
    );
  });
});

describe('THEIRSIDE_DATABASE_CA_FILE in the config', () => {
  const env = (ca: string) => ({ DATABASE_URL: url, THEIRSIDE_DATABASE_CA_FILE: ca });
  it('is checked at start', () => {
    expect(loadConfig(env(bundle)).databaseCaFile).toBe(bundle);
    expect(loadConfig({ DATABASE_URL: url }).databaseCaFile).toBeUndefined();
    expect(() => loadConfig(env('/nowhere/ca.pem'))).toThrow(/cannot read \/nowhere\/ca\.pem/);
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-ca-'));
    writeFileSync(path.join(dir, 'empty.pem'), 'not a certificate');
    expect(() => loadConfig(env(path.join(dir, 'empty.pem')))).toThrow(/holds no PEM certificate/);
  });
});
