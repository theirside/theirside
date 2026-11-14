import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { databaseTlsStatus, pgConnectionConfig } from '../src/storage/pg-connection.js';

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

describe('databaseTlsStatus: a warning for a remote database that is not verified', () => {
  const RDS = 'theirside.abc123xyz.eu-west-1.rds.amazonaws.com';
  it.each([
    // [DATABASE_URL, CA file, warning expected]
    ['postgres://ts:pw@postgres:5432/theirside', undefined, false], // Compose service name
    ['postgres://ts:pw@localhost:5432/theirside', undefined, false],
    ['postgres://ts:pw@127.0.0.1:5432/theirside?sslmode=disable', undefined, false],
    ['postgres://ts:pw@[::1]:5432/theirside', undefined, false],
    ['socket:/var/run/postgresql?db=theirside', undefined, false], // Unix socket
    [`postgres://ts:pw@${RDS}:5432/theirside`, undefined, true], // RDS, no sslmode
    ['postgres://ts:pw@10.0.12.7:5432/theirside?sslmode=require', undefined, true], // private IP
    [`postgres://ts:pw@${RDS}:5432/theirside?sslmode=no-verify`, undefined, true],
    [`postgres://ts:pw@${RDS}:5432/theirside?sslmode=verify-full`, bundle, false],
    [`postgres://ts:pw@${RDS}:5432/theirside`, bundle, false], // the CA file turns verification on
    ['postgres://ts:pw@db.example.test:5432/theirside?sslmode=verify-full', undefined, false], // public CA
  ] as const)('%s (CA file: %s) -> warning %s', (u, ca, warned) => {
    const s = databaseTlsStatus(u, ca);
    expect(s.warning !== null).toBe(warned);
    // the password never appears
    expect(JSON.stringify(s)).not.toContain(':pw@');
  });

  it('names the fix: the RDS bundle for RDS hosts, the provider CA otherwise, and the docs', () => {
    const rds = databaseTlsStatus(`postgres://ts:pw@${RDS}:5432/theirside`).warning!;
    expect(rds).toContain(`The database connection to ${RDS} is not verified (sslmode=not set)`);
    expect(rds).toContain(
      'add sslmode=verify-full to DATABASE_URL and set THEIRSIDE_DATABASE_CA_FILE=/app/certs/rds-global-bundle.pem',
    );
    expect(rds).toContain('https://theirside.dev/docs/self-hosting#database-tls');
    const other = databaseTlsStatus(
      'postgres://ts:pw@10.0.12.7:5432/theirside?sslmode=require',
    ).warning!;
    expect(other).toContain('(sslmode=require)');
    expect(other).toContain("set THEIRSIDE_DATABASE_CA_FILE to your provider's CA file");
    expect(other).not.toContain('rds-global-bundle');
  });
});

describe('GET /v1/admin/system', () => {
  it('shows admins the database TLS status (the test database is local: no warning)', async () => {
    const { startTestApp, THEIRSIDE_ADMIN_TOKEN } = await import('./helpers.js');
    const t = await startTestApp();
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/system',
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().databaseTls).toMatchObject({
      local: true,
      warning: null,
      docs: 'https://theirside.dev/docs/self-hosting#database-tls',
    });
    expect(JSON.stringify(res.json())).not.toMatch(/postgres:\/\//);
    await t.close();
  });
});
