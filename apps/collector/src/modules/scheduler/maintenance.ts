import type { EntitlementsResolver } from '../entitlements/types.js';
import type { Storage } from '../../storage/types.js';
import type { Job } from './scheduler.js';

const DAY_MS = 86_400_000;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Create raw-event partitions for today and `ahead` days after; drop those past retention. */
export function partitionJob(
  storage: Storage,
  opts: { ahead: number; rawRetentionDays: number },
  log?: (m: string) => void,
): Job {
  return {
    name: 'partitions',
    async run(now) {
      const today = startOfUtcDay(now);
      const created = await storage.events.ensurePartitions(today, opts.ahead + 1);
      // keep `rawRetentionDays` full days before today
      const dropped = await storage.events.dropPartitionsBefore(
        new Date(today.getTime() - opts.rawRetentionDays * DAY_MS),
      );
      if (created.length || dropped.length)
        log?.(`partitions created=[${created.join(',')}] dropped=[${dropped.join(',')}]`);
    },
  };
}

/**
 * Delete rollups older than THEIRSIDE_ROLLUP_RETENTION_DAYS, capped per org by the
 * `retentionDays` entitlement (cloud plans) when that is lower.
 */
export function rollupRetentionJob(
  storage: Storage,
  entitlements: EntitlementsResolver,
  opts: { rollupRetentionDays: number },
): Job {
  return {
    name: 'rollup-retention',
    async run(now) {
      const today = startOfUtcDay(now).getTime();
      for (const org of await storage.config.listOrgs()) {
        const ent = await entitlements.for(org.id);
        const days =
          ent.retentionDays === null
            ? opts.rollupRetentionDays
            : Math.min(ent.retentionDays, opts.rollupRetentionDays);
        const cutoff = new Date(today - days * DAY_MS);
        for (const p of await storage.config.listProjects(org.id)) {
          await storage.rollups.deleteBefore(cutoff, { orgId: org.id, projectId: p.id });
        }
      }
    },
  };
}
