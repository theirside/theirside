/**
 * Collector configuration, from environment variables only (architecture §3.3).
 * THEIRSIDE_DEPLOYMENT_MODE changes defaults, never feature checks (those go through entitlements).
 */
export type DeploymentMode = 'self_hosted' | 'cloud';

export interface SmtpConfig {
  /** smtp://user:pass@host:587 (STARTTLS) or smtps://user:pass@host:465; wins over host/port/… */
  url: string | undefined;
  host: string | undefined;
  port: number;
  /** Implicit TLS (465). false = STARTTLS when the server offers it. */
  secure: boolean;
  /** Refuse to send unless the connection is TLS (STARTTLS or implicit). */
  requireTls: boolean;
  user: string | undefined;
  pass: string | undefined;
  from: string;
}

export interface CollectorConfig {
  databaseUrl: string;
  host: string;
  port: number;
  deploymentMode: DeploymentMode;
  /**
   * Base URL of the dashboard, used for links in alerts (omitted when unset)
   * and the status page/embed URLs (request origin when unset).
   */
  publicUrl: string | undefined;
  bootstrapApiKey: string | undefined;
  bootstrapOrgName: string;
  bootstrapProjectName: string;
  adminToken: string | undefined;
  licenseKey: string | undefined;
  /** Accept licences signed with the committed dev key (tests and local trials only). */
  allowDevLicense: boolean;
  rawRetentionDays: number;
  rollupRetentionDays: number;
  partitionsAhead: number;
  schedulerEnabled: boolean;
  schedulerIntervalMs: number;
  smtp: SmtpConfig | undefined;
  logLevel: string;
  /** Where the dashboard build is served from. */
  staticDir: string | undefined;
  /** Status page cache TTL, seconds. */
  statusCacheSeconds: number;
  /**
   * Public-facing instance: serve only the status page, embed.js and health
   * checks (everything else 404), and run no scheduler. The main instance
   * with the dashboard and ingest stays on the private network.
   */
  publicPathsOnly: boolean;
  /**
   * JSON file with extra catalog entries (`{ "providers": [...] }`, same shape
   * as packages/shared/catalog.json). For demos and tests.
   */
  catalogOverridePath: string | undefined;
}

function int(env: NodeJS.ProcessEnv, name: string, dflt: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, dflt: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const mode = (env.THEIRSIDE_DEPLOYMENT_MODE || 'self_hosted') as DeploymentMode;
  if (mode !== 'self_hosted' && mode !== 'cloud') {
    throw new Error('THEIRSIDE_DEPLOYMENT_MODE must be self_hosted or cloud');
  }
  const port = int(env, 'PORT', 4318, 1);
  const smtpUrl = env.THEIRSIDE_SMTP_URL || undefined;
  const smtpHost = env.THEIRSIDE_SMTP_HOST || undefined;
  const smtpUser = env.THEIRSIDE_SMTP_USER || undefined;
  const smtpSecure = bool(env, 'THEIRSIDE_SMTP_SECURE', false);
  if (smtpUrl && !/^smtps?:\/\//.test(smtpUrl))
    throw new Error('THEIRSIDE_SMTP_URL must start with smtp:// or smtps://');
  return {
    databaseUrl,
    host: env.HOST || '0.0.0.0',
    port,
    deploymentMode: mode,
    publicUrl: env.THEIRSIDE_PUBLIC_URL ? env.THEIRSIDE_PUBLIC_URL.replace(/\/$/, '') : undefined,
    // self-hosted bootstraps a single org from env; cloud creates orgs via signup (private repo)
    bootstrapApiKey:
      mode === 'self_hosted' ? env.THEIRSIDE_BOOTSTRAP_API_KEY || undefined : undefined,
    bootstrapOrgName: env.THEIRSIDE_BOOTSTRAP_ORG_NAME || 'Default org',
    bootstrapProjectName: env.THEIRSIDE_BOOTSTRAP_PROJECT_NAME || 'Default project',
    adminToken: env.THEIRSIDE_ADMIN_TOKEN || undefined,
    licenseKey: env.THEIRSIDE_LICENSE_KEY || undefined,
    allowDevLicense: bool(env, 'THEIRSIDE_ALLOW_DEV_LICENSE', false),
    rawRetentionDays: int(env, 'THEIRSIDE_RAW_RETENTION_DAYS', 30, 1),
    rollupRetentionDays: int(env, 'THEIRSIDE_ROLLUP_RETENTION_DAYS', 90, 1),
    partitionsAhead: int(env, 'THEIRSIDE_PARTITIONS_AHEAD_DAYS', 3, 1),
    schedulerEnabled: bool(env, 'THEIRSIDE_SCHEDULER_ENABLED', true),
    schedulerIntervalMs: int(env, 'THEIRSIDE_SCHEDULER_INTERVAL_MS', 60_000, 1000),
    smtp:
      smtpUrl || smtpHost
        ? {
            url: smtpUrl,
            host: smtpHost,
            port: int(env, 'THEIRSIDE_SMTP_PORT', smtpSecure ? 465 : 587, 1),
            secure: smtpSecure,
            // credentials never go over plain text unless explicitly allowed
            requireTls: bool(
              env,
              'THEIRSIDE_SMTP_REQUIRE_TLS',
              !!(smtpUser || (smtpUrl && /\/\/[^/]*@/.test(smtpUrl))),
            ),
            user: smtpUser,
            pass: env.THEIRSIDE_SMTP_PASS || undefined,
            from: env.THEIRSIDE_SMTP_FROM || 'theirside@localhost',
          }
        : undefined,
    logLevel: env.LOG_LEVEL || 'info',
    staticDir: env.THEIRSIDE_STATIC_DIR || undefined,
    statusCacheSeconds: int(env, 'THEIRSIDE_STATUS_CACHE_SECONDS', 30, 0),
    publicPathsOnly: bool(env, 'THEIRSIDE_PUBLIC_PATHS_ONLY', false),
    catalogOverridePath: env.THEIRSIDE_CATALOG_OVERRIDE || undefined,
  };
}
