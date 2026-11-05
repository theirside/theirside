import type { EntitlementsResolver } from '../entitlements/types.js';
import type { UsageStore } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';

interface MonthCount {
  month: string;
  calls: number;
  refreshedAt: number;
}

/**
 * Enforces `monthlyCallLimit` only when entitlements set one. Month-to-date
 * usage is read from usage_daily at most once a minute per org and kept
 * current in memory between reads, so ingest doesn't pay a query per batch.
 */
export class UsageLimiter {
  private readonly counts = new Map<string, MonthCount>();

  constructor(
    private readonly usage: UsageStore,
    private readonly entitlements: EntitlementsResolver,
    private readonly clock: Clock,
    private readonly refreshMs = 60_000,
  ) {}

  /** True when accepting `calls` more would exceed the org's monthly limit. */
  async wouldExceed(orgId: string, calls: number): Promise<boolean> {
    const ent = await this.entitlements.for(orgId);
    if (ent.monthlyCallLimit === null) return false;
    const now = this.clock.now();
    const month = now.toISOString().slice(0, 7);
    let c = this.counts.get(orgId);
    if (!c || c.month !== month || now.getTime() - c.refreshedAt > this.refreshMs) {
      c = {
        month,
        calls: await this.usage.orgCallsSince(orgId, `${month}-01`),
        refreshedAt: now.getTime(),
      };
      this.counts.set(orgId, c);
    }
    return c.calls + calls > ent.monthlyCallLimit;
  }

  recordAccepted(orgId: string, calls: number): void {
    const c = this.counts.get(orgId);
    if (c) c.calls += calls;
  }
}
