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
import { LoginThrottle } from './modules/auth/throttle.js';
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
  limiter: UsageLimiter;
  adapters: AdapterMap;
  alerts: AlertDispatcher;
  /** Auto-discovery: hosts → providers. */
  directory: ProviderDirectory;
}

export interface ContextOverrides {
  clock?: Clock;
  /** Cloud plugs its plan-based resolver in here (private repo). */
  entitlements?: EntitlementsResolver;
  log?: (msg: string) => void;
  /** Replace alert channel adapters (tests; ee/ paging integrations add kinds the same way). */
  adapters?: AdapterMap;
  /** Directory limits (tests use small caps). */
  directoryLimits?: DirectoryLimits;
  /** Account emails (invites, resets); tests capture them. */
  mailer?: Mailer;
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
  const entitlements =
    o.entitlements ??
    new LicenseEntitlementsResolver({
      licenseKey: config.licenseKey,
      allowDevLicense: config.allowDevLicense,
      clock,
      ...(o.log ? { log: o.log } : {}),
    });
  const adapters = o.adapters ?? defaultAdapters(config.smtp);
  const sessions = new SessionManager(storage.auth, storage.config, clock, {
    maxAgeMs: config.sessionMaxAgeHours * 3600_000,
    idleMs: config.sessionIdleHours * 3600_000,
  });
  const accounts = new Accounts(
    storage,
    config,
    clock,
    sessions,
    new LoginThrottle(storage.auth, clock),
    o.mailer ?? smtpMailer(config.smtp),
    entitlements,
  );
  return {
    config,
    storage,
    clock,
    entitlements,
    apiKeys: new ApiKeyAuthenticator(storage.config, clock),
    sessions,
    accounts,
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
