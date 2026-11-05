/** Thin client for the collector's dashboard API (same origin, session cookie). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

// CSRF token of the current session (from sign-in and /v1/me), sent on every write
let csrfToken = '';

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 401 && !path.startsWith('/v1/auth/')) onUnauthorized();
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // `detail` is the human-readable explanation when the server sends one
    const d = data as { error?: string; detail?: string };
    throw new ApiError(res.status, d.detail ?? d.error ?? `HTTP ${res.status}`);
  }
  const token = (data as { csrfToken?: unknown }).csrfToken;
  if (typeof token === 'string') csrfToken = token;
  return data as T;
}

export type HealthStatus = 'green' | 'amber' | 'red' | 'unknown';

export interface EndpointHealth {
  environment: string;
  method: string;
  endpoint: string;
  status: HealthStatus;
  score: number | null;
  callsPerMin: number;
  errorRate: number;
  normalErrorRate: number;
  rate4xx: number;
  rate429: number;
  p50Ms: number | null;
  p95Ms: number | null;
  normalP95Ms: number | null;
  learning: boolean;
  inIncident: boolean;
  outcomes: Record<string, number>;
}

export type ProviderSource = 'configured' | 'discovered' | 'catalog';

export interface ProviderHealth {
  name: string;
  displayName: string | null;
  /** Dashboard name: rename, else name. */
  label: string;
  isPublic: boolean;
  source: ProviderSource;
  category: string | null;
  firstSeenAt: string | null;
  alertsEnabled: boolean;
  status: HealthStatus;
  score: number | null;
  callsPerMin: number;
  errorRate: number;
  normalErrorRate: number;
  p95Ms: number | null;
  normalP95Ms: number | null;
  openIncidentId: string | null;
  endpoints: EndpointHealth[];
}

export interface Incident {
  id: string;
  environment: string;
  provider: string;
  scope: 'endpoint' | 'provider';
  kind: 'errors' | 'latency';
  status: 'open' | 'resolved';
  openedAt: string;
  resolvedAt: string | null;
  durationMinutes: number;
  peakErrorRate: number;
  peakP95Ms: number | null;
  alertsMuted: boolean;
  endpoints: {
    method: string;
    endpoint: string;
    firstSeenAt: string;
    recoveredAt: string | null;
    peakErrorRate: number;
  }[];
  summary: string;
  sampleRequestIds: string[];
}

export interface Overview {
  generatedAt: string;
  minute: string;
  windowMinutes: number;
  environment: string | null;
  providers: ProviderHealth[];
  openIncidents: Incident[];
  environments: string[];
  discovery: {
    recent: { name: string; label: string; category: string | null; firstSeenAt: string }[];
    overflow: boolean;
  };
}

export interface SeriesPoint {
  t: string;
  calls: number;
  callsPerMin: number;
  errorRate: number;
  outcomeRates: Record<string, number>;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface Series {
  range: '1h' | '24h' | '7d';
  bucketMinutes: number;
  points: SeriesPoint[];
  baseline: {
    errorRate: number;
    errorThreshold: number;
    p95Ms: number | null;
    learning: boolean;
  } | null;
}

export interface Provider {
  id: string;
  name: string;
  hostPatterns: string[];
  explicitRoutes: string[];
  supportEmail: string | null;
  supportUrl: string | null;
  supportNotes: string | null;
  publicDisplayName: string | null;
  isPublic: boolean;
  source: ProviderSource;
  category: string | null;
  hosts: string[];
  domain: string | null;
  hidden: boolean;
  internal: boolean;
  alertsEnabled: boolean;
  firstSeenAt: string;
  displayName: string | null;
  /** Path privacy for the SDK; null = the SDK's own `pathPrivacy` (default strict). */
  pathPrivacy: 'strict' | 'balanced' | null;
  allowedPathWords: string[];
}

export interface AlertChannel {
  id: string;
  kind: 'slack' | 'email' | 'webhook';
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface Delivery {
  id: string;
  channelId: string;
  incidentId: string | null;
  event: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  title: string | null;
}

export interface SdkInstance {
  service: string;
  environment: string;
  sdkName: string;
  sdkVersion: string;
  firstSeenAt: string;
  lastSeenAt: string;
  droppedEvents: number;
  lastFlushError: string | null;
  stale: boolean;
}

export interface StatusPage {
  id: string;
  title: string;
  publicToken: string;
  theme: 'auto' | 'light' | 'dark';
  providerFilter: string[];
  url: string;
  embedSnippet: string;
}

export interface StatusPageList {
  statusPages: StatusPage[];
  limit: number | null;
  used: number;
  canCreate: boolean;
  limitMessage?: string;
}

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ('ingest' | 'read')[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type Role = 'admin' | 'member';

export interface Me {
  userId: string;
  orgId: string;
  role: Role;
  /** session = signed in here; proxy = identity proxy; admin-token = Bearer token. */
  via: 'session' | 'proxy' | 'admin-token';
  /** null for the admin token's system user. */
  user: { id: string; email: string | null; name: string } | null;
  /** Signed in with THEIRSIDE_ADMIN_TOKEN (break-glass): no account settings. */
  breakGlass: boolean;
  twoFactor: { enabled: boolean; enrollmentRequired: boolean };
  csrfToken: string | null;
  projects: { id: string; name: string }[];
  entitlements: { plan: string; source: string };
}

export interface AuthStatus {
  setupRequired: boolean;
  emailEnabled: boolean;
  adminTokenEnabled: boolean;
  proxy: 'header' | 'alb' | null;
}

export interface UserRow {
  id: string;
  email: string | null;
  name: string;
  source: 'password' | 'proxy';
  role: Role;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
  twoFactor: boolean;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

/** A one-time link the collector made (invite or password reset). */
export interface LinkResult {
  url: string;
  expiresAt: string;
  emailed: boolean;
  emailError?: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
  required: boolean;
  available: boolean;
}
