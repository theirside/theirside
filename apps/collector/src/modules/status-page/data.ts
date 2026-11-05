import type { HealthStatus } from '../scoring/evaluate.js';
import type { StatusPageRecord, Storage } from '../../storage/types.js';
import { computeHealth } from '../api/health.js';

const DAY = 86_400_000;
export const UPTIME_DAYS = 30;

export type PublicStatus = 'operational' | 'degraded' | 'outage' | 'no_data';

export interface PublicDay {
  date: string;
  /** null = no traffic that day. */
  uptime: number | null;
  level: 'ok' | 'degraded' | 'outage' | 'no_data';
}

export interface PublicProvider {
  name: string;
  status: PublicStatus;
  days: PublicDay[];
  uptime30d: number | null;
}

export interface PublicStatusData {
  title: string;
  generatedAt: string;
  overall: PublicStatus;
  providers: PublicProvider[];
}

const PUBLIC: Record<HealthStatus, PublicStatus> = {
  green: 'operational',
  amber: 'degraded',
  red: 'outage',
  unknown: 'no_data',
};

/** Minutes of incident on a day before the day counts as an outage rather than degraded. */
const OUTAGE_MINUTES = 30;

/**
 * What a status page may show: only providers marked public (and in the page's
 * filter), under their public display name, with current status and a 30-day
 * bar. Uptime per day = 1 − minutes covered by (non-muted) incidents / minutes
 * in the day. No endpoint paths, no call volumes.
 */
export async function statusPageData(
  storage: Storage,
  page: StatusPageRecord,
  now: Date,
  filter?: string[],
): Promise<PublicStatusData> {
  const tenant = { orgId: page.orgId, projectId: page.projectId };
  const configured = (await storage.config.listProviders(tenant)).filter(
    (p) => p.isPublic && (page.providerFilter.length === 0 || page.providerFilter.includes(p.name)),
  );
  const health = await computeHealth(storage, tenant, now);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (UPTIME_DAYS - 1) * DAY);

  const providers: PublicProvider[] = [];
  for (const p of configured) {
    const name = p.publicDisplayName || p.name;
    if (filter && filter.length > 0 && !filter.some((f) => f.toLowerCase() === name.toLowerCase()))
      continue;
    const h = health.providers.find((x) => x.name === p.name);
    const daily = await storage.rollups.series(tenant, {
      from,
      to: new Date(today + DAY),
      bucketMinutes: 1440,
      provider: p.name,
    });
    const traffic = new Set(
      daily.filter((r) => r.total > 0).map((r) => new Date(r.minute).getTime()),
    );
    const incidents = (
      await storage.incidents.list(tenant, { provider: p.name, since: from, limit: 1000 })
    ).filter((i) => !i.alertsMuted);
    const days: PublicDay[] = [];
    let upSum = 0;
    let upDays = 0;
    for (let d = from.getTime(); d <= today; d += DAY) {
      const dayEnd = Math.min(d + DAY, now.getTime());
      let incidentMs = 0;
      for (const i of incidents) {
        const s = Math.max(i.openedAt.getTime(), d);
        const e = Math.min((i.resolvedAt ?? now).getTime(), dayEnd);
        if (e > s) incidentMs += e - s;
      }
      const hadTraffic = traffic.has(d);
      if (!hadTraffic && incidentMs === 0) {
        days.push({ date: new Date(d).toISOString().slice(0, 10), uptime: null, level: 'no_data' });
        continue;
      }
      const uptime = Math.max(0, 1 - incidentMs / Math.max(1, dayEnd - d));
      upSum += uptime;
      upDays++;
      days.push({
        date: new Date(d).toISOString().slice(0, 10),
        uptime,
        level:
          incidentMs === 0 ? 'ok' : incidentMs > OUTAGE_MINUTES * 60_000 ? 'outage' : 'degraded',
      });
    }
    providers.push({
      name,
      status: h ? PUBLIC[h.status] : 'no_data',
      days,
      uptime30d: upDays > 0 ? upSum / upDays : null,
    });
  }
  const rank: Record<PublicStatus, number> = { outage: 0, degraded: 1, operational: 2, no_data: 3 };
  const worst = providers.reduce<PublicStatus>(
    (w, p) => (rank[p.status] < rank[w] ? p.status : w),
    providers.some((p) => p.status === 'operational') ? 'operational' : 'no_data',
  );
  return { title: page.title, generatedAt: now.toISOString(), overall: worst, providers };
}
