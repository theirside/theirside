import type { SdkInstanceRecord, SdkProcessRecord } from '../../storage/types.js';

/**
 * SDK health per service and environment (Settings → SDK health). A service
 * runs one way or the other:
 *
 * - long-running (SDK 0.2.0+ sends a heartbeat every 5 minutes when idle):
 *   `running`, `idle` (alive, no calls for a while) or `not_running` (no batch
 *   at all for 15 minutes);
 * - short-lived (serverless functions, or processes that live under 10
 *   minutes: cron jobs, scripts): never judged by minutes since last seen. The
 *   page shows the last invocation, and `silent` only when the service sent
 *   regularly (10+ batches) and has been quiet for 8× its usual gap and at
 *   least an hour;
 * - legacy (SDKs before 0.2.0: no process ids, no heartbeat): `stale` after 10
 *   minutes without a batch, as before, since idle and stopped look the same.
 */
export type SdkServiceKind = 'long-running' | 'short-lived' | 'legacy';
export type SdkServiceStatus = 'running' | 'idle' | 'not_running' | 'ok' | 'silent' | 'stale';

export interface SdkServiceHealth {
  service: string;
  environment: string;
  kind: SdkServiceKind;
  status: SdkServiceStatus;
  /** True when the status warns (not running, silent, stale); kept for older dashboards. */
  stale: boolean;
  platform: string | null;
  sdkName: string;
  sdkVersion: string;
  /** SDK versions seen in the last day (several during a rollout). */
  sdkVersions: string[];
  processes: { active: number; lastDay: number };
  firstSeenAt: string;
  lastSeenAt: string;
  /** Last batch with calls: for short-lived services, the last invocation. */
  lastEventAt: string | null;
  usualGapSeconds: number | null;
  droppedEvents: number;
  lastFlushError: string | null;
}

const MIN = 60_000;
export const SDK_HEALTH = {
  /** A long-running process sends a heartbeat every 5 min: 3 missed = not running. */
  notRunningAfterMs: 15 * MIN,
  /** A process seen for less than this is short-lived. */
  shortLivedMs: 10 * MIN,
  /** Silent: this many usual gaps… */
  silentGaps: 8,
  /** …and at least this long. */
  silentMinMs: 60 * MIN,
  /** Batches with calls before a service counts as regular. */
  regularBatches: 10,
  /** A process seen within this is active. */
  activeMs: 15 * MIN,
  legacyStaleMs: 10 * MIN,
} as const;

export function sdkHealth(
  s: SdkInstanceRecord & { eventGapSeconds?: number | null; eventBatches?: number },
  processes: readonly SdkProcessRecord[],
  now: Date,
): SdkServiceHealth {
  const t = now.getTime();
  const mine = processes.filter((p) => p.service === s.service && p.environment === s.environment);
  const lastDay = mine.filter((p) => t - p.lastSeenAt.getTime() < 24 * 60 * MIN);
  const lifetimes = lastDay.map((p) => p.lastSeenAt.getTime() - p.startedAt.getTime());
  const sorted = [...lifetimes].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  const shortLived =
    s.serverless ||
    mine.some((p) => p.serverless) ||
    (lastDay.length >= 2 && median !== null && median < SDK_HEALTH.shortLivedMs);
  const kind: SdkServiceKind = shortLived ? 'short-lived' : mine.length ? 'long-running' : 'legacy';
  const sinceSeen = t - s.lastSeenAt.getTime();
  const sinceEvent = s.lastEventAt ? t - s.lastEventAt.getTime() : null;
  const gap = s.eventGapSeconds ?? null;

  let status: SdkServiceStatus;
  if (kind === 'short-lived') {
    const regular = (s.eventBatches ?? 0) >= SDK_HEALTH.regularBatches && gap !== null;
    const limit =
      gap === null
        ? Infinity
        : Math.max(SDK_HEALTH.silentGaps * gap * 1000, SDK_HEALTH.silentMinMs);
    status = regular && sinceEvent !== null && sinceEvent > limit ? 'silent' : 'ok';
  } else if (kind === 'long-running') {
    if (sinceSeen > SDK_HEALTH.notRunningAfterMs) status = 'not_running';
    else
      status =
        sinceEvent === null || sinceEvent > SDK_HEALTH.notRunningAfterMs ? 'idle' : 'running';
  } else {
    status = sinceSeen > SDK_HEALTH.legacyStaleMs ? 'stale' : 'running';
  }

  return {
    service: s.service,
    environment: s.environment,
    kind,
    status,
    stale: status === 'not_running' || status === 'silent' || status === 'stale',
    platform: s.platform ?? mine.find((p) => p.platform)?.platform ?? null,
    sdkName: s.sdkName,
    sdkVersion: s.sdkVersion,
    sdkVersions: [...new Set(lastDay.map((p) => p.sdkVersion).concat(s.sdkVersion))].sort(),
    processes: {
      active: mine.filter((p) => t - p.lastSeenAt.getTime() < SDK_HEALTH.activeMs).length,
      lastDay: lastDay.length,
    },
    firstSeenAt: s.firstSeenAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    lastEventAt: s.lastEventAt?.toISOString() ?? null,
    usualGapSeconds: gap === null ? null : Math.round(gap),
    droppedEvents: s.droppedEvents,
    lastFlushError: s.lastFlushError,
  };
}
