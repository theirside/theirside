import type { Outcome, RollupRow } from '@theirside/shared';

/**
 * Repository interfaces (architecture §5.5). Collector modules depend only on
 * these; Postgres implements all of them, and cloud can move EventStore /
 * RollupStore elsewhere without touching scoring or API code.
 */

export interface Tenant {
  orgId: string;
  projectId: string;
}

// ------------------------------------------------------------------ events

export interface StoredEvent {
  ts: Date;
  service: string;
  environment: string;
  sdkVersion: string;
  provider: string;
  host: string;
  method: string;
  endpoint: string;
  status: number | null;
  durationMs: number;
  outcome: Outcome;
  errorCode: string | null;
  correlationId: string | null;
  providerRequestId: string | null;
}

export interface EventSample {
  ts: Date;
  endpoint: string;
  method: string;
  outcome: Outcome;
  status: number | null;
  errorCode: string | null;
  providerRequestId: string | null;
  correlationId: string | null;
}

export interface EventStore {
  insert(tenant: Tenant, receivedAt: Date, events: StoredEvent[]): Promise<void>;
  /** Recent failing events with a provider request id, newest first. */
  sampleFailures(
    tenant: Tenant,
    q: {
      environment: string;
      provider: string;
      endpoints?: { endpoint: string; method: string }[];
      since: Date;
      limit: number;
    },
  ): Promise<EventSample[]>;
  /** Re-label raw events of provider `from` as `to` (incident samples follow a merge). */
  moveProvider(tenant: Tenant, from: string, to: string): Promise<number>;
  /** Ensure daily partitions exist for [from, from + days). Returns names created. */
  ensurePartitions(from: Date, days: number): Promise<string[]>;
  /** Drop partitions whose whole day is before `before`. Returns names dropped. */
  dropPartitionsBefore(before: Date): Promise<string[]>;
  listPartitions(): Promise<string[]>;
}

// ------------------------------------------------------------------ rollups

/** Additive delta for one rollup key, built in memory per ingest batch. */
export type RollupDelta = Omit<RollupRow, 'orgId' | 'projectId'>;

export interface RollupKey {
  environment: string;
  provider: string;
  endpoint: string;
  method: string;
}

export interface RollupQuery {
  from: Date;
  /** Exclusive. */
  to: Date;
  environment?: string;
  provider?: string;
  endpoint?: string;
  method?: string;
}

export interface RollupStore {
  upsert(tenant: Tenant, deltas: RollupDelta[]): Promise<void>;
  /** Raw per-minute rows, ordered by minute. */
  query(tenant: Tenant, q: RollupQuery): Promise<RollupRow[]>;
  /** Rows summed per key (environment, provider, endpoint, method) over the range. */
  aggregateByKey(
    tenant: Tenant,
    q: RollupQuery,
  ): Promise<(RollupRow & { minutes: number; firstMinute: string })[]>;
  /** Rows summed per bucket of `bucketMinutes`, for charts. */
  series(tenant: Tenant, q: RollupQuery & { bucketMinutes: number }): Promise<RollupRow[]>;
  /** Every (tenant, key) with traffic in the range: what the scheduler scores. */
  activeKeys(from: Date): Promise<(Tenant & RollupKey)[]>;
  /** Re-key every row of provider `from` to `to`, adding into rows that already exist. */
  moveProvider(tenant: Tenant, from: string, to: string): Promise<number>;
  deleteBefore(before: Date, tenant?: Tenant): Promise<number>;
}

// ------------------------------------------------------------------ incidents

export interface Baseline extends RollupKey {
  providerErrorRate: number;
  rate4xx: number;
  rate429: number;
  p50Ms: number | null;
  p95Ms: number | null;
  sampleSize: number;
  historyMinutes: number;
  learning: boolean;
  computedAt: Date;
}

export interface IncidentEndpoint {
  endpoint: string;
  method: string;
  firstSeenAt: Date;
  recoveredAt: Date | null;
  peakErrorRate: number;
}

export interface Incident extends Tenant {
  id: string;
  environment: string;
  provider: string;
  scope: 'endpoint' | 'provider';
  kind: 'errors' | 'latency';
  status: 'open' | 'resolved';
  openedAt: Date;
  resolvedAt: Date | null;
  lastAlertedRate: number | null;
  lastAlertedP95Ms: number | null;
  /** Last minute the incident engine processed (ticks are idempotent per minute). */
  lastEvaluatedMinute: Date | null;
  /** Opened inside a cooldown: tracked, never alerted. */
  alertsMuted: boolean;
  peakErrorRate: number;
  peakP95Ms: number | null;
  baseline: Record<string, unknown>;
  summary: string;
  sampleRequestIds: string[];
  endpoints: IncidentEndpoint[];
}

export interface IncidentListQuery {
  status?: 'open' | 'resolved';
  provider?: string;
  limit?: number;
  since?: Date;
}

export interface IncidentStore {
  getBaselines(tenant: Tenant): Promise<Baseline[]>;
  /** Incidents of `from` become `to`'s; `from`'s baselines are dropped (recomputed). */
  moveProvider(tenant: Tenant, from: string, to: string): Promise<void>;
  upsertBaselines(tenant: Tenant, baselines: Baseline[]): Promise<void>;
  /** Minute ranges covered by incidents touching this endpoint, for baseline exclusion. */
  incidentWindows(
    tenant: Tenant,
    key: RollupKey,
    since: Date,
  ): Promise<{ from: Date; to: Date | null }[]>;
  list(tenant: Tenant, q: IncidentListQuery): Promise<Incident[]>;
  get(tenant: Tenant, id: string): Promise<Incident | null>;
  listOpenAll(): Promise<Incident[]>;
  /** Latest resolved_at per endpoint, for cooldown checks. */
  lastResolvedAt(
    tenant: Tenant,
    environment: string,
    provider: string,
    endpoint: string,
    method: string,
  ): Promise<Date | null>;
  create(incident: Incident): Promise<void>;
  update(incident: Incident): Promise<void>;
}

// ------------------------------------------------------------------ config

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type ApiKeyScope = 'ingest' | 'read';

export interface ApiKeyRecord extends Tenant {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type ProviderSource = 'configured' | 'discovered' | 'catalog';

export interface ProviderRecord extends Tenant {
  id: string;
  /** Key under which rollups, incidents and baselines are stored. */
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
  /** Exact hosts seen (capped); subdomain floods fold into a `*.domain` host pattern. */
  hosts: string[];
  domain: string | null;
  /** Stop collecting (pushed to the SDK). */
  hidden: boolean;
  /** The team's own service: never collected. */
  internal: boolean;
  alertsEnabled: boolean;
  firstSeenAt: Date;
  /** Dashboard rename; `name` stays the storage key. */
  displayName: string | null;
  /** Path privacy set in the dashboard (pushed to the SDK); null = the SDK's own setting. */
  pathPrivacy: 'strict' | 'balanced' | null;
  /** Extra words the SDK may send as-is in strict path privacy (lower-case). */
  allowedPathWords: string[];
}

type ProviderDiscoveryFields =
  | 'source'
  | 'category'
  | 'hosts'
  | 'domain'
  | 'hidden'
  | 'internal'
  | 'alertsEnabled'
  | 'firstSeenAt'
  | 'displayName'
  | 'pathPrivacy'
  | 'allowedPathWords';

export type ProviderInput = Omit<
  ProviderRecord,
  'id' | 'orgId' | 'projectId' | ProviderDiscoveryFields
> &
  Partial<Pick<ProviderRecord, ProviderDiscoveryFields>>;

/** A host the collector assigned to a provider during ingest. */
export interface DiscoveredHost {
  name: string;
  host: string;
  domain: string;
  source: Exclude<ProviderSource, 'configured'>;
  category: string;
  alertsEnabled: boolean;
}

export interface AlertChannelRecord extends Tenant {
  id: string;
  kind: 'slack' | 'email' | 'webhook';
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export type AlertChannelInput = Omit<AlertChannelRecord, 'id' | 'orgId' | 'projectId'>;

export interface AlertDelivery extends Tenant {
  id: string;
  channelId: string;
  incidentId: string | null;
  event: 'open' | 'escalation' | 'resolve' | 'test' | 'discovery';
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  sentAt: Date | null;
}

export interface StatusPageRecord extends Tenant {
  id: string;
  publicToken: string;
  title: string;
  providerFilter: string[];
  theme: 'auto' | 'light' | 'dark';
}

export interface SdkInstanceRecord extends Tenant {
  service: string;
  environment: string;
  sdkName: string;
  sdkVersion: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  droppedEvents: number;
  lastFlushError: string | null;
}

export interface SdkHeartbeat {
  service: string;
  environment: string;
  sdkName: string;
  sdkVersion: string;
  dropped: number;
  lastFlushError: string | null;
}

export interface MembershipRecord {
  orgId: string;
  userId: string;
  role: Role;
}

export interface ConfigStore {
  // tenancy
  createOrg(id: string, name: string): Promise<void>;
  listOrgs(): Promise<{ id: string; name: string }[]>;
  createUser(id: string, name: string, email: string | null): Promise<void>;
  addMembership(m: MembershipRecord): Promise<void>;
  membershipsForUser(userId: string): Promise<MembershipRecord[]>;
  createProject(orgId: string, id: string, name: string): Promise<void>;
  listProjects(orgId: string): Promise<{ id: string; name: string }[]>;
  countProjects(orgId: string): Promise<number>;

  // api keys
  createApiKey(
    rec: Omit<ApiKeyRecord, 'createdAt' | 'lastUsedAt' | 'revokedAt'>,
    keyHash: string,
  ): Promise<void>;
  findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  listApiKeys(tenant: Tenant): Promise<ApiKeyRecord[]>;
  revokeApiKey(tenant: Tenant, id: string): Promise<boolean>;
  touchApiKey(id: string, at: Date): Promise<void>;

  // providers
  listProviders(tenant: Tenant): Promise<ProviderRecord[]>;
  upsertProvider(tenant: Tenant, input: ProviderInput): Promise<ProviderRecord>;
  updateProvider(
    tenant: Tenant,
    id: string,
    input: Partial<ProviderInput>,
  ): Promise<ProviderRecord | null>;
  deleteProvider(tenant: Tenant, id: string): Promise<boolean>;
  /** Insert providers seen in traffic that have no config row yet. */
  ensureProviders(tenant: Tenant, names: string[], hosts: Map<string, string>): Promise<void>;
  /**
   * Auto-discovery: create the provider if needed and add the host to its
   * `hosts` (up to `maxHosts`). Returns the provider after the change.
   */
  recordDiscoveredHost(
    tenant: Tenant,
    d: DiscoveredHost,
    maxHosts: number,
  ): Promise<ProviderRecord>;
  countProviders(tenant: Tenant): Promise<number>;
  /**
   * Provider merge, config part: hosts, host patterns and routes of `fromId`
   * are added to `intoId`, then `fromId` is deleted. Data is moved by the
   * rollup/incident/event stores in the same transaction (discovery/merge.ts).
   */
  absorbProvider(tenant: Tenant, fromId: string, intoId: string): Promise<ProviderRecord | null>;
  getDiscoveryDigest(tenant: Tenant): Promise<boolean>;
  setDiscoveryDigest(tenant: Tenant, enabled: boolean): Promise<void>;
  /** Providers first seen and not yet in a digest; marks them notified. */
  takeUndigestedProviders(tenant: Tenant): Promise<ProviderRecord[]>;

  // alert channels and deliveries
  listAlertChannels(tenant: Tenant): Promise<AlertChannelRecord[]>;
  getAlertChannel(tenant: Tenant, id: string): Promise<AlertChannelRecord | null>;
  createAlertChannel(tenant: Tenant, input: AlertChannelInput): Promise<AlertChannelRecord>;
  updateAlertChannel(
    tenant: Tenant,
    id: string,
    input: Partial<AlertChannelInput>,
  ): Promise<AlertChannelRecord | null>;
  deleteAlertChannel(tenant: Tenant, id: string): Promise<boolean>;
  createDelivery(d: AlertDelivery): Promise<void>;
  updateDelivery(d: AlertDelivery): Promise<void>;
  dueDeliveries(now: Date, limit: number): Promise<AlertDelivery[]>;
  listDeliveries(tenant: Tenant, limit: number): Promise<AlertDelivery[]>;

  // status pages
  listStatusPages(tenant: Tenant): Promise<StatusPageRecord[]>;
  /** Status pages across all projects of an org (for the maxStatusPages entitlement). */
  countStatusPages(orgId: string): Promise<number>;
  createStatusPage(
    tenant: Tenant,
    rec: Omit<StatusPageRecord, 'id' | 'orgId' | 'projectId'>,
  ): Promise<StatusPageRecord>;
  findStatusPageByToken(token: string): Promise<StatusPageRecord | null>;
  updateStatusPage(
    tenant: Tenant,
    id: string,
    patch: Partial<Pick<StatusPageRecord, 'title' | 'providerFilter' | 'theme'>>,
  ): Promise<StatusPageRecord | null>;
  deleteStatusPage(tenant: Tenant, id: string): Promise<boolean>;

  // settings
  getThresholds(tenant: Tenant): Promise<Record<string, unknown>>;
  setThresholds(tenant: Tenant, thresholds: Record<string, unknown>): Promise<void>;

  // sdk health
  recordSdkHeartbeat(tenant: Tenant, hb: SdkHeartbeat, at: Date): Promise<void>;
  listSdkInstances(tenant: Tenant): Promise<SdkInstanceRecord[]>;

  // install metadata
  getMeta(key: string): Promise<string | null>;
  setMetaIfAbsent(key: string, value: string): Promise<string>;
  setMeta(key: string, value: string): Promise<void>;
  deleteMetaPrefix(prefix: string): Promise<void>;
}

export type AuthSource = 'password' | 'proxy' | 'system';

export interface UserRecord {
  id: string;
  email: string | null;
  name: string;
  authSource: AuthSource;
  passwordHash: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** TOTP 2FA is on. */
  totpEnabled: boolean;
}

export interface TotpState {
  /** Encrypted secret (SecretBox) once enabled; pending = enrolment not confirmed yet. */
  secretEnc: string | null;
  pendingEnc: string | null;
  lastStep: number | null;
}

export interface SessionRecord {
  idHash: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export type AuthTokenKind = 'invite' | 'reset' | 'mfa';

export interface AuthTokenRecord {
  id: string;
  kind: AuthTokenKind;
  tokenHash: string;
  orgId: string;
  userId: string | null;
  email: string | null;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface ThrottleState {
  failures: number;
  windowStart: Date;
  lockedUntil: Date | null;
}

/** Users, sessions, one-time tokens and login throttling (modules/auth). */
export interface AuthStore {
  /** Users that can sign in (a password or a proxy identity); system users excluded. */
  countSignInUsers(): Promise<number>;
  getUser(id: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  /** Users with a membership in the org, system users excluded, oldest first. */
  listUsers(orgId: string): Promise<UserRecord[]>;
  createUser(u: {
    id: string;
    email: string | null;
    name: string;
    authSource: AuthSource;
    passwordHash: string | null;
  }): Promise<void>;
  /** Insert a system user if missing (idempotent across replicas). */
  ensureSystemUser(id: string, name: string): Promise<void>;
  /** Claim a user without a password (the placeholder admin of older bootstraps). */
  updateUserProfile(id: string, email: string, name: string): Promise<void>;
  setPassword(userId: string, hash: string, at: Date): Promise<void>;
  markLogin(userId: string, at: Date): Promise<void>;
  deleteUser(id: string): Promise<boolean>;

  createSession(s: SessionRecord): Promise<void>;
  findSession(idHash: string): Promise<SessionRecord | null>;
  touchSession(idHash: string, at: Date): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
  /** All of a user's sessions, except `keepIdHash`. Returns how many were removed. */
  deleteUserSessions(userId: string, keepIdHash?: string): Promise<number>;
  countUserSessions(userId: string, now: Date): Promise<number>;
  /** Sessions past their expiry or idle since before `idleBefore`. */
  purgeSessions(now: Date, idleBefore: Date): Promise<void>;

  createToken(t: AuthTokenRecord): Promise<void>;
  findToken(kind: AuthTokenKind, tokenHash: string): Promise<AuthTokenRecord | null>;
  /** Marks an unused token used; false if it was already used (one-time). */
  useToken(id: string, at: Date): Promise<boolean>;
  /** Unused tokens of a kind for a user (e.g. older reset links). */
  revokeUserTokens(kind: AuthTokenKind, userId: string): Promise<void>;
  revokeInvitesForEmail(orgId: string, email: string): Promise<void>;
  listInvites(orgId: string, now: Date): Promise<AuthTokenRecord[]>;
  /** A pending (unused, unexpired) invite for this email in any org. */
  findInviteByEmail(email: string, now: Date): Promise<AuthTokenRecord | null>;
  deleteInvite(orgId: string, id: string): Promise<boolean>;
  purgeTokens(now: Date): Promise<void>;

  getThrottle(keys: string[]): Promise<Map<string, ThrottleState>>;
  /**
   * Count a failure for `key` in a window of `windowMs`; at `limit` failures the key
   * is locked for `lockMs`. Atomic across replicas. Returns the new state.
   */
  recordFailure(
    key: string,
    now: Date,
    opts: { windowMs: number; limit: number; lockMs: number },
  ): Promise<ThrottleState>;
  clearThrottle(key: string): Promise<void>;
  /** Drop counts whose window ended before `before` and that aren't locked any more. */
  purgeThrottle(now: Date, before: Date): Promise<void>;

  getTotp(userId: string): Promise<TotpState | null>;
  setTotpPending(userId: string, pendingEnc: string | null): Promise<void>;
  /** Pending secret becomes the secret; `step` was just used, so it can't be replayed. */
  enableTotp(userId: string, secretEnc: string, step: number, at: Date): Promise<void>;
  /** 2FA off: secret, pending secret and recovery codes removed. */
  disableTotp(userId: string): Promise<void>;
  /** Accept a code's step only if it is after the last accepted one (atomic). */
  advanceTotpStep(userId: string, step: number): Promise<boolean>;
  /** All encrypted TOTP secrets, for key rotation. */
  listTotpSecrets(): Promise<
    { userId: string; secretEnc: string | null; pendingEnc: string | null }[]
  >;
  updateTotpSecrets(
    userId: string,
    secretEnc: string | null,
    pendingEnc: string | null,
  ): Promise<void>;
  replaceRecoveryCodes(userId: string, hashes: string[], at: Date): Promise<void>;
  /** Marks an unused code used; false if unknown or already used. */
  useRecoveryCode(userId: string, hash: string, at: Date): Promise<boolean>;
  countRecoveryCodes(userId: string): Promise<number>;
  getRequire2fa(orgId: string): Promise<boolean>;
  setRequire2fa(orgId: string, required: boolean): Promise<void>;
}

export interface UsageStore {
  add(tenant: Tenant, day: string, callsIngested: number, droppedReported: number): Promise<void>;
  /** Calls ingested from `fromDay` (inclusive, YYYY-MM-DD) for the whole org. */
  orgCallsSince(orgId: string, fromDay: string): Promise<number>;
  list(
    tenant: Tenant,
    fromDay: string,
  ): Promise<{ day: string; callsIngested: number; eventsDroppedReported: number }[]>;
}

/** All repositories, plus a unit of work so ingest is one transaction. */
export interface Storage {
  events: EventStore;
  rollups: RollupStore;
  incidents: IncidentStore;
  config: ConfigStore;
  usage: UsageStore;
  auth: AuthStore;
  transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T>;
  /** Run fn only on the instance that holds the named advisory lock; null if not leader. */
  withLeaderLock<T>(name: string, fn: () => Promise<T>): Promise<T | null>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
