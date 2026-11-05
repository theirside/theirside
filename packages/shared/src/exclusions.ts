/**
 * Hosts auto-discovery never records (docs/privacy.md, "Auto-discovery").
 * Checked in the SDK before anything is recorded, and again by the collector.
 * Dependency-free: part of the core the SDK bundles.
 */

export type ExclusionReason = 'loopback' | 'private' | 'metadata' | 'internal-name' | 'telemetry';

/** Cloud metadata endpoints (instance credentials live there). */
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2', // ECS task metadata/credentials
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata',
]);

/** Suffixes of names that only resolve inside a private network. */
const INTERNAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.corp',
  '.home.arpa',
  '.lan',
  '.svc',
  '.cluster.local',
];

/**
 * Telemetry/observability ingest hosts: the app's own monitoring, not providers.
 * Suffix match on the registrable part (`*.sentry.io` and `sentry.io`).
 */
export const TELEMETRY_DOMAINS: readonly string[] = [
  'sentry.io',
  'datadoghq.com',
  'datadoghq.eu',
  'ddog-gov.com',
  'browser-intake-datadoghq.com',
  'newrelic.com',
  'nr-data.net',
  'honeycomb.io',
  'lightstep.com',
  'grafana.net',
  'logz.io',
  'bugsnag.com',
  'rollbar.com',
  'raygun.io',
  'opsgenie.com',
  'loggly.com',
  'papertrailapp.com',
  'logdna.com',
  'mezmo.com',
  'elastic-cloud.com',
  'signalfx.com',
  'splunkcloud.com',
  'appsignal.com',
  'scoutapm.com',
  'instana.io',
  'dynatrace.com',
  'live.dynatrace.com',
];

/** AWS X-Ray API endpoints (`xray.<region>.amazonaws.com`); the daemon itself is on loopback. */
const RE_XRAY = /^xray\.[a-z0-9-]+\.amazonaws\.com$/;

function ipv4Parts(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function classifyIpv4(p: number[]): ExclusionReason | null {
  const [a, b] = p as [number, number];
  if (a === 127 || a === 0) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'private'; // link-local (incl. metadata)
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // carrier-grade NAT / VPC shared space
  return null;
}

function classifyIpv6(h: string): ExclusionReason | null {
  const s = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (!s.includes(':')) return null;
  if (s === '::1' || s === '::') return 'loopback';
  // IPv4-mapped (::ffff:10.0.0.1)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) {
    const p = ipv4Parts(mapped[1]!);
    return p ? classifyIpv4(p) : null;
  }
  const first = parseInt(s.split(':')[0] || '0', 16);
  if ((first & 0xffc0) === 0xfe80) return 'private'; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local (incl. fd00:ec2::254)
  return null;
}

/**
 * Why a host must never be recorded by auto-discovery, or null when it may be.
 * `hostname` without port; any case.
 */
export function exclusionReason(hostname: string): ExclusionReason | null {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (h === '') return 'internal-name';
  if (METADATA_HOSTS.has(h) || METADATA_HOSTS.has(h.replace(/^\[|\]$/g, ''))) return 'metadata';
  if (h === 'localhost') return 'loopback';
  const v4 = ipv4Parts(h);
  if (v4) return classifyIpv4(v4);
  const v6 = classifyIpv6(h);
  if (v6) return v6;
  if (h.includes(':')) return null; // public IPv6
  // single-label names (`redis`, `users-service`) only resolve inside a network
  if (!h.includes('.')) return 'internal-name';
  if (INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) return 'internal-name';
  if (RE_XRAY.test(h)) return 'telemetry';
  for (const d of TELEMETRY_DOMAINS) if (h === d || h.endsWith('.' + d)) return 'telemetry';
  return null;
}
