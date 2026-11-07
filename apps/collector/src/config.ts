import { isIP } from 'node:net';
import { SECRET_KEY_MIN_LENGTH } from './modules/auth/secret-box.js';

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
  /** Dashboard sessions: absolute lifetime and idle timeout, hours. */
  sessionMaxAgeHours: number;
  sessionIdleHours: number;
  /**
   * Which proxies' X-Forwarded-* headers to believe (request IP for login throttling,
   * https detection for links and Secure cookies): by default proxies on private and
   * loopback addresses (PRIVATE_PROXY_RANGES); or comma-separated addresses/CIDRs of
   * the load balancers, a hop count, false = none, true = any (logged as a warning).
   */
  trustProxy: boolean | number | string[];
  /**
   * Encrypts TOTP secrets at rest (required for 2FA). At least 32 characters, e.g.
   * `openssl rand -base64 32`. Keep a backup: without it, 2FA codes can't be checked.
   */
  secretKey: string | undefined;
  /** Older keys, comma-separated: still decrypt, and secrets are re-encrypted at start. */
  secretKeyPrevious: string[];
  /** Sign-in by a trusted proxy in front of the collector (off unless THEIRSIDE_AUTH_PROXY is set). */
  authProxy: AuthProxyConfig | undefined;
  /**
   * Emails (lower case) that become admins when an identity proxy creates their
   * account; everyone else it creates is a member (or gets the invite's role).
   */
  adminEmails: string[];
  /**
   * THEIRSIDE_DESIGN_GALLERY: the dashboard's #/design page (tokens and components,
   * docs/design-system.md) opens without sign-in. Off: the page doesn't exist.
   */
  designGallery: boolean;
}

export interface AuthProxyConfig {
  /** header: an email in `header`; alb: AWS ALB's signed x-amzn-oidc-data JWT. */
  mode: 'header' | 'alb';
  /** Addresses/CIDRs of the proxies; the header is ignored from any other peer. */
  trustedIps: string[];
  /** header mode: lower-case header name. */
  header: string;
  /** alb mode: the load balancer's ARN (the JWT's `signer`); region and partition come from it. */
  albArn: string | undefined;
  /** Create an account on a first sign-in instead of requiring an invite. */
  autoCreate: boolean;
}

const ALB_ARN_RE =
  /^arn:(aws|aws-cn|aws-us-gov):elasticloadbalancing:([a-z0-9-]+):\d{12}:loadbalancer\/app\/[^/]+\/[0-9a-f]+$/;

function cidrEntry(raw: string): string {
  const [addr, prefix, extra] = raw.split('/');
  const family = addr ? isIP(addr) : 0;
  const max = family === 4 ? 32 : 128;
  if (
    !family ||
    extra !== undefined ||
    (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > max))
  )
    throw new Error(`THEIRSIDE_AUTH_PROXY_TRUSTED_IPS: '${raw}' is not an IP address or CIDR`);
  return raw;
}

function authProxyConfig(env: NodeJS.ProcessEnv): AuthProxyConfig | undefined {
  const mode = (env.THEIRSIDE_AUTH_PROXY || 'off').toLowerCase();
  if (mode === 'off' || mode === 'false') return undefined;
  if (mode !== 'header' && mode !== 'alb')
    throw new Error('THEIRSIDE_AUTH_PROXY must be off, header or alb');
  const trustedIps = (env.THEIRSIDE_AUTH_PROXY_TRUSTED_IPS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map(cidrEntry);
  if (trustedIps.length === 0)
    throw new Error(
      'THEIRSIDE_AUTH_PROXY_TRUSTED_IPS is required with THEIRSIDE_AUTH_PROXY: the addresses of the proxy (e.g. the ALB subnets)',
    );
  const albArn = env.THEIRSIDE_AUTH_PROXY_ALB_ARN || undefined;
  if (mode === 'alb' && (!albArn || !ALB_ARN_RE.test(albArn)))
    throw new Error(
      'THEIRSIDE_AUTH_PROXY_ALB_ARN must be the ALB ARN (arn:aws:elasticloadbalancing:<region>:<account>:loadbalancer/app/<name>/<id>)',
    );
  return {
    mode,
    trustedIps,
    header: (env.THEIRSIDE_AUTH_PROXY_HEADER || 'x-forwarded-email').toLowerCase(),
    albArn,
    autoCreate: bool(env, 'THEIRSIDE_AUTH_PROXY_AUTO_CREATE', false),
  };
}

function secretKey(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw.length < SECRET_KEY_MIN_LENGTH)
    throw new Error(
      `${name} must be at least ${SECRET_KEY_MIN_LENGTH} characters (e.g. openssl rand -base64 32)`,
    );
  return raw;
}

/** Default THEIRSIDE_TRUST_PROXY: load balancers on a private network or the same host. */
export const PRIVATE_PROXY_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  'fc00::/7',
  '::1/128',
];

function trustProxySetting(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined || raw.trim() === '') return PRIVATE_PROXY_RANGES;
  if (/^(true|yes|on)$/i.test(raw.trim())) return true;
  if (/^(false|0|no|off)$/i.test(raw.trim())) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
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
    sessionMaxAgeHours: int(env, 'THEIRSIDE_SESSION_MAX_AGE_HOURS', 168, 1),
    sessionIdleHours: int(env, 'THEIRSIDE_SESSION_IDLE_HOURS', 24, 1),
    trustProxy: trustProxySetting(env.THEIRSIDE_TRUST_PROXY),
    secretKey: secretKey(env.THEIRSIDE_SECRET_KEY, 'THEIRSIDE_SECRET_KEY'),
    secretKeyPrevious: (env.THEIRSIDE_SECRET_KEY_PREVIOUS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => secretKey(k, 'THEIRSIDE_SECRET_KEY_PREVIOUS')!),
    authProxy: authProxyConfig(env),
    adminEmails: (env.THEIRSIDE_ADMIN_EMAILS ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    designGallery: bool(env, 'THEIRSIDE_DESIGN_GALLERY', false),
  };
}
