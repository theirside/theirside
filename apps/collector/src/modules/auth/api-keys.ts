import { API_KEY_PREFIX } from '@theirside/shared';
import type { ApiKeyRecord, ApiKeyScope, ConfigStore, Tenant } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';
import { newId, randomBase62, sha256Hex } from '../../util/ids.js';

/** `tsd_live_` + 32 base62 characters (~190 bits). */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBase62(32);
}

export function isWellFormedApiKey(key: string): boolean {
  return (
    key.startsWith(API_KEY_PREFIX) && key.length >= API_KEY_PREFIX.length + 16 && key.length <= 128
  );
}

export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

export function keyPrefixForDisplay(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + 4);
}

export async function createApiKey(
  config: ConfigStore,
  tenant: Tenant,
  name: string,
  scopes: ApiKeyScope[],
  key = generateApiKey(),
): Promise<{ key: string; record: Omit<ApiKeyRecord, 'createdAt' | 'lastUsedAt' | 'revokedAt'> }> {
  const record = { id: newId('key'), ...tenant, name, keyPrefix: keyPrefixForDisplay(key), scopes };
  await config.createApiKey(record, hashApiKey(key));
  return { key, record };
}

interface CacheEntry {
  record: ApiKeyRecord | null;
  expires: number;
}

/**
 * Resolves bearer keys to tenants. Lookups are cached for `ttlMs` (default 60 s),
 * so a revoked key stops working within that time; last_used_at is written at
 * most once a minute per key.
 */
export class ApiKeyAuthenticator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly config: ConfigStore,
    private readonly clock: Clock,
    private readonly ttlMs = 60_000,
  ) {}

  async authenticate(key: string | undefined, scope: ApiKeyScope): Promise<ApiKeyRecord | null> {
    if (!key || !isWellFormedApiKey(key)) return null;
    const hash = hashApiKey(key);
    const now = this.clock.now().getTime();
    let entry = this.cache.get(hash);
    if (!entry || entry.expires <= now) {
      entry = { record: await this.config.findApiKeyByHash(hash), expires: now + this.ttlMs };
      if (this.cache.size > 10_000) this.cache.clear();
      this.cache.set(hash, entry);
    }
    const rec = entry.record;
    if (!rec || rec.revokedAt || !rec.scopes.includes(scope)) return null;
    const last = this.touched.get(rec.id) ?? 0;
    if (now - last > 60_000) {
      this.touched.set(rec.id, now);
      this.config.touchApiKey(rec.id, new Date(now)).catch(() => {});
    }
    return rec;
  }

  invalidate(): void {
    this.cache.clear();
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim();
}
