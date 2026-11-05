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
import { SessionAuth } from './modules/auth/session.js';
import { LicenseEntitlementsResolver } from './modules/entitlements/license.js';
import type { EntitlementsResolver } from './modules/entitlements/types.js';
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
  sessions: SessionAuth;
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
  return {
    config,
    storage,
    clock,
    entitlements,
    apiKeys: new ApiKeyAuthenticator(storage.config, clock),
    sessions: new SessionAuth(storage.config, clock, config.adminToken),
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
