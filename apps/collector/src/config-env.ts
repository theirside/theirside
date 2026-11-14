/**
 * Every environment variable `loadConfig` (config.ts) reads, documented in one place.
 * docs/site/configuration.md is generated from this list (`pnpm docs:generate`), and a
 * test fails when config.ts reads a variable that isn't listed here, or the other way
 * round. `internal`: for development, tests or the cloud edition; left out of the docs.
 */
export interface CollectorEnvVar {
  name: string;
  /** As the docs show it: `4318`, `required`, `–` (unset). */
  default: string;
  description: string;
  group: 'Basics' | 'First run' | 'Sign-in and security' | 'Email' | 'Data' | 'Advanced';
  internal?: boolean;
}

export const COLLECTOR_ENV: readonly CollectorEnvVar[] = [
  {
    name: 'DATABASE_URL',
    default: 'required',
    description:
      'Postgres 13+ connection string, `postgres://user:pass@host:5432/db`. Migrations run on start (safe with several instances).',
    group: 'Basics',
  },
  {
    name: 'THEIRSIDE_DATABASE_CA_FILE',
    default: '–',
    description:
      'PEM file with the CA certificates the database’s TLS certificate must chain to; with it, TLS is on and the host name is checked too (use `sslmode=verify-full` in `DATABASE_URL`). The image includes AWS RDS’s global bundle: `/app/certs/rds-global-bundle.pem`. For another provider, mount its CA file and point this at it.',
    group: 'Basics',
  },
  {
    name: 'PORT',
    default: '`4318`',
    description: 'Port the collector listens on.',
    group: 'Basics',
  },
  {
    name: 'HOST',
    default: '`0.0.0.0`',
    description: 'Address the collector listens on.',
    group: 'Basics',
  },
  {
    name: 'THEIRSIDE_PUBLIC_URL',
    default: '–',
    description:
      'Where people open the dashboard. Used for links in alerts (none when unset) and the session cookie’s `Secure` flag.',
    group: 'Basics',
  },
  {
    name: 'LOG_LEVEL',
    default: '`info`',
    description: '`debug`, `info`, `warn` or `error`.',
    group: 'Basics',
  },
  {
    name: 'THEIRSIDE_BOOTSTRAP_API_KEY',
    default: '–',
    description:
      'Project API key created on the first start (`tsd_live_` + at least 16 characters). With neither this nor `THEIRSIDE_ADMIN_TOKEN`, the first start generates a key and logs a one-time setup link.',
    group: 'First run',
  },
  {
    name: 'THEIRSIDE_ADMIN_TOKEN',
    default: '–',
    description:
      'Completes the setup page and is the break-glass sign-in (also `Authorization: Bearer` for scripts). Unset it to turn it off.',
    group: 'First run',
  },
  {
    name: 'THEIRSIDE_BOOTSTRAP_ORG_NAME',
    default: '`Default org`',
    description: 'Organisation name created on the first start.',
    group: 'First run',
  },
  {
    name: 'THEIRSIDE_BOOTSTRAP_PROJECT_NAME',
    default: '`Default project`',
    description: 'Project name created on the first start.',
    group: 'First run',
  },
  {
    name: 'THEIRSIDE_SECRET_KEY',
    default: '–',
    description:
      'Encrypts two-factor secrets; required for two-factor sign-in. At least 32 characters (`openssl rand -base64 32`). Back it up.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_SECRET_KEY_PREVIOUS',
    default: '–',
    description:
      'Old keys (comma-separated) still accepted while you rotate `THEIRSIDE_SECRET_KEY`.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_TRUST_PROXY',
    default: 'private ranges',
    description:
      'Leave unset unless your load balancer reaches the collector from a public address, or you want to trust only its subnets. Default: `X-Forwarded-*` from proxies on private and loopback addresses is believed. Otherwise your load balancers’ CIDRs, a hop count, `false`, or `true` (any; logged as a warning).',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_SESSION_MAX_AGE_HOURS',
    default: '`168`',
    description: 'Dashboard session lifetime.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_SESSION_IDLE_HOURS',
    default: '`24`',
    description: 'Dashboard session idle timeout.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_AUTH_PROXY',
    default: '`off`',
    description:
      '`header` (oauth2-proxy, Pomerium, Cloudflare Access…) or `alb` (AWS ALB with OIDC): sign people in from the identity proxy in front.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_AUTH_PROXY_TRUSTED_IPS',
    default: '–',
    description:
      'Required with `THEIRSIDE_AUTH_PROXY`: the proxy’s addresses or CIDRs, comma-separated.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_AUTH_PROXY_HEADER',
    default: '`x-forwarded-email`',
    description: 'Header carrying the signed-in email (`header` mode).',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_AUTH_PROXY_ALB_ARN',
    default: '–',
    description:
      'Required in `alb` mode: the load balancer’s ARN, checked against the signed header.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_AUTH_PROXY_AUTO_CREATE',
    default: '`false`',
    description: 'Create an account (member) for a proxy user who has none.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_ADMIN_EMAILS',
    default: '–',
    description: 'Comma-separated emails that become admins when the proxy creates their account.',
    group: 'Sign-in and security',
  },
  {
    name: 'THEIRSIDE_SMTP_URL',
    default: '–',
    description:
      'Email alerts, invites and password resets: `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465` (TLS). URL-encode special characters in the password.',
    group: 'Email',
  },
  {
    name: 'THEIRSIDE_SMTP_HOST',
    default: '–',
    description: 'Instead of the URL: the SMTP server…',
    group: 'Email',
  },
  {
    name: 'THEIRSIDE_SMTP_PORT',
    default: '`587` (`465` with `SECURE`)',
    description: '…its port…',
    group: 'Email',
  },
  {
    name: 'THEIRSIDE_SMTP_SECURE',
    default: '`false`',
    description: '…TLS from the start (port 465) instead of STARTTLS…',
    group: 'Email',
  },
  { name: 'THEIRSIDE_SMTP_USER', default: '–', description: '…user…', group: 'Email' },
  { name: 'THEIRSIDE_SMTP_PASS', default: '–', description: '…and password.', group: 'Email' },
  {
    name: 'THEIRSIDE_SMTP_REQUIRE_TLS',
    default: '`true` with credentials',
    description: 'Refuse to send credentials over plain text. `false` allows it.',
    group: 'Email',
  },
  {
    name: 'THEIRSIDE_SMTP_FROM',
    default: '`theirside@localhost`',
    description: 'Sender address; most providers only accept a verified sender or domain.',
    group: 'Email',
  },
  {
    name: 'THEIRSIDE_RAW_RETENTION_DAYS',
    default: '`30`',
    description: 'Days raw call events are kept (daily partitions).',
    group: 'Data',
  },
  {
    name: 'THEIRSIDE_ROLLUP_RETENTION_DAYS',
    default: '`90`',
    description: 'Days per-minute rollups (charts, baselines, the status page) are kept.',
    group: 'Data',
  },
  {
    name: 'THEIRSIDE_PARTITIONS_AHEAD_DAYS',
    default: '`3`',
    description: 'Daily event partitions created ahead of time.',
    group: 'Data',
  },
  {
    name: 'THEIRSIDE_PUBLIC_PATHS_ONLY',
    default: '`false`',
    description:
      '`true` for a public status-page instance: serves only `/status/*`, `/embed.js`, `/fonts/*` and health checks, and runs no jobs.',
    group: 'Advanced',
  },
  {
    name: 'THEIRSIDE_STATUS_CACHE_SECONDS',
    default: '`30`',
    description: 'How long status pages may be cached by browsers and CDNs.',
    group: 'Advanced',
  },
  {
    name: 'THEIRSIDE_SCHEDULER_ENABLED',
    default: '`true`',
    description:
      'Run the incident, alert and maintenance jobs here. With several instances one is elected; `false` keeps an instance ingest-only.',
    group: 'Advanced',
  },
  {
    name: 'THEIRSIDE_CATALOG_OVERRIDE',
    default: '–',
    description:
      'Path to a JSON file with extra provider catalog entries (`{ "providers": [{ "name", "category", "domains": [] }] }`), e.g. to name an internal partner API.',
    group: 'Advanced',
  },
  {
    name: 'THEIRSIDE_LICENSE_KEY',
    default: '–',
    description: 'Unlocks paid features. Never needed for ingest, detection or alerts.',
    group: 'Advanced',
  },
  {
    name: 'THEIRSIDE_DESIGN_GALLERY',
    default: '`false`',
    description:
      'Opens the dashboard’s `#/design` page (design tokens, no data) without sign-in. Leave off in production.',
    group: 'Advanced',
  },
  {
    name: 'THEIRSIDE_DEPLOYMENT_MODE',
    default: '`self_hosted`',
    description: '`cloud` for the hosted edition.',
    group: 'Advanced',
    internal: true,
  },
  {
    name: 'THEIRSIDE_ALLOW_DEV_LICENSE',
    default: '`false`',
    description: 'Accept licences signed with the development key (tests).',
    group: 'Advanced',
    internal: true,
  },
  {
    name: 'THEIRSIDE_SCHEDULER_INTERVAL_MS',
    default: '`60000`',
    description: 'Scheduler tick (tests).',
    group: 'Advanced',
    internal: true,
  },
  {
    name: 'THEIRSIDE_STATIC_DIR',
    default: 'the built dashboard',
    description: 'Directory the dashboard is served from (development).',
    group: 'Advanced',
    internal: true,
  },
  {
    name: 'THEIRSIDE_SIM',
    default: '`false`',
    description: 'Simulation mode on a simulation database (`pnpm sim`).',
    group: 'Advanced',
    internal: true,
  },
];
