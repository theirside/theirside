import type { ConfigStore, StatusPageRecord, Tenant } from '../../storage/types.js';
import type { Entitlements } from '../entitlements/types.js';

export class StatusPageLimitError extends Error {
  constructor(readonly limit: number) {
    super(`status page limit reached (${limit}); more status pages need a licence`);
  }
}

/** The only way to create a status page: enforces the maxStatusPages entitlement per org. */
export async function createStatusPage(
  config: ConfigStore,
  entitlements: Entitlements,
  tenant: Tenant,
  rec: Omit<StatusPageRecord, 'id' | 'orgId' | 'projectId'>,
): Promise<StatusPageRecord> {
  const limit = entitlements.maxStatusPages;
  if (limit !== null && (await config.countStatusPages(tenant.orgId)) >= limit) {
    throw new StatusPageLimitError(limit);
  }
  return config.createStatusPage(tenant, rec);
}
