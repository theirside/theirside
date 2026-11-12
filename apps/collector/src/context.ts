import { readFileSync } from 'node:fs';
import { Catalog, type CatalogEntry } from '@theirside/shared';
import {
  DEFAULT_DIRECTORY_LIMITS,
  ProviderDirectory,
  type DirectoryLimits,
} from './modules/discovery/directory.js';
import type { CollectorConfig } from './config.js';
import { defaultAdapters, type ChannelAdapter } from './modules/alerts/channels.js';
import { AlertDispatcher } from './modules/alerts/dispatcher.js';
import { ApiKeyAuthenticator } from './modules/auth/api-keys.js';
import { Accounts } from './modules/auth/accounts.js';
import { SessionManager } from './modules/auth/session.js';
import { ProxyAuth, type AlbKeyFetcher } from './modules/auth/proxy-auth.js';
import { SecretBox } from './modules/auth/secret-box.js';
import { LoginThrottle } from './modules/auth/throttle.js';
import { TwoFactor } from './modules/auth/two-factor.js';
import { LicenseEntitlementsResolver } from './modules/entitlements/license.js';
import type { EntitlementsResolver } from './modules/entitlements/types.js';
import { smtpMailer, type Mailer } from './modules/mail/mailer.js';
import { UsageLimiter } from './modules/usage/limits.js';
import type { AlertChannelRecord, Storage } from './storage/types.js';
import { systemClock, type Clock } from './util/clock.js';

export type AdapterMap = Map<AlertChannelRecord['kind'], ChannelAdapter>;

/** Everything a request handler or job needs; built once at startup (or per test). */
export interface AppContext {
  config: CollectorConfig;
  storage: Storage;
  clock: Clock;
  entitlements: EntitlementsResolver;
  apiKeys: ApiKeyAuthenticator;
  sessions: SessionManager;
  /** User accounts: setup, sign-in, invites, password resets. */
  accounts: Accounts;
  /** Sign-in by a trusted reverse proxy (THEIRSIDE_AUTH_PROXY); undefined when off. */
  proxyAuth: ProxyAuth | undefined;
  limiter: UsageLimiter;
  adapters: AdapterMap;
  alerts: AlertDispatcher;
  /** Auto-discovery: hosts → providers. */
  directory: ProviderDirectory;
}

export interface ContextOverrides {
  /** Product time: ingest, rollups, scoring, incidents, alerts, retention, dashboards. */
  clock?: Clock;
  /**
   * Time for accounts and credentials (sessions, 2FA codes, login throttling, invites,
   * API-key use, proxy tokens, the licence): default `clock`. Simulation mode keeps it
   * on the real clock, so a simulated week doesn't expire sessions or break 2FA codes.
   */
  wallClock?: Clock;
  /** Cloud plugs its plan-based resolver in here (private repo). */
  entitlements?: EntitlementsResolver;
  log?: (msg: string) => void;
  /** Replace alert channel adapters (tests; ee/ paging integrations add kinds the same way). */
  adapters?: AdapterMap;
  /** Directory limits (tests use small caps). */
  directoryLimits?: DirectoryLimits;
  /** Account emails (invites, resets); tests capture them. */
  mailer?: Mailer;
  /** Where ALB public keys come from (tests sign their own tokens). */
  albKeyFetcher?: AlbKeyFetcher;
}

function loadCatalog(path: string | undefined): Catalog {
  if (!path) return new Catalog();
  const extra = (JSON.parse(readFileSync(path, 'utf8')) as { providers?: CatalogEntry[] })
    .providers;
  return new Catalog(undefined, Array.isArray(extra) ? extra : []);
}

export function createContext(
  config: CollectorConfig,
  storage: Storage,
  o: ContextOverrides = {},
): AppContext {
  const clock = o.clock ?? systemClock;
  const wall = o.wallClock ?? clock;
  const entitlements =
    o.entitlements ??
    new LicenseEntitlementsResolver({
      licenseKey: config.licenseKey,
      allowDevLicense: config.allowDevLicense,
      clock: wall,
      ...(o.log ? { log: o.log } : {}),
    });
  const adapters = o.adapters ?? defaultAdapters(config.smtp);
  const sessions = new SessionManager(storage.auth, storage.config, wall, {
    maxAgeMs: config.sessionMaxAgeHours * 3600_000,
    idleMs: config.sessionIdleHours * 3600_000,
  });
  const accounts = new Accounts(
    storage,
    config,
    wall,
    sessions,
    new LoginThrottle(storage.auth, wall),
    o.mailer ?? smtpMailer(config.smtp),
    entitlements,
    new TwoFactor(storage, wall, new SecretBox(config.secretKey, config.secretKeyPrevious)),
  );
  return {
    config,
    storage,
    clock,
    entitlements,
    apiKeys: new ApiKeyAuthenticator(storage.config, wall),
    sessions,
    accounts,
    proxyAuth: config.authProxy
      ? new ProxyAuth(config.authProxy, wall, o.albKeyFetcher)
      : undefined,
    limiter: new UsageLimiter(storage.usage, entitlements, clock),
    adapters,
    alerts: new AlertDispatcher(storage, adapters, clock, o.log),
    directory: new ProviderDirectory(
      storage,
      clock,
      loadCatalog(config.catalogOverridePath),
      o.directoryLimits ?? DEFAULT_DIRECTORY_LIMITS,
    ),
  };
}
