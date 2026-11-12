import { emptyStatusCounts, type StatusCounts } from '@theirside/shared';
import type { ProviderRecord, RollupKey } from '../../storage/types.js';
import type { RollupCounts } from './evaluate.js';

/**
 * Expected outcomes marked from the dashboard (docs/scoring.md "Expected outcomes"):
 * "400 is a normal answer for GET /v1/consent". Rollups keep the raw counts; scoring
 * counts the marked statuses as successful (`applyExpected`), and a safety net opens a
 * behaviour incident when a marked status takes over (`EXPECTED_SURGE_*`).
 *
 * Only the 4xx statuses rollups count one by one can be marked. Never 5xx, timeouts or
 * connection errors (they aren't answers), nor 429 (the provider limiting us).
 * Marking in code (SDK `markExpected`) is more precise: it tags single calls, works
 * for any 4xx, and untagged calls with the same status still alert.
 */
export const EXPECTABLE_STATUSES = [400, 401, 403, 404, 409, 422] as const;
export type ExpectableStatus = (typeof EXPECTABLE_STATUSES)[number];

const KEY_OF: Record<ExpectableStatus, keyof StatusCounts> = {
  400: 's400',
  401: 's401',
  403: 's403',
  404: 's404',
  409: 's409',
  422: 's422',
};

export const isExpectable = (s: unknown): s is ExpectableStatus =>
  (EXPECTABLE_STATUSES as readonly unknown[]).includes(s);

export const statusKey = (s: ExpectableStatus): keyof StatusCounts => KEY_OF[s];

/** The provider config key of an endpoint: `GET /v1/consent`. */
export const expectedKey = (k: { method: string; endpoint: string }) => `${k.method} ${k.endpoint}`;

/** Statuses marked expected for one key (none: []). */
export type ExpectedLookup = (key: RollupKey) => readonly ExpectableStatus[];

export const noExpected: ExpectedLookup = () => [];

/** From the tenant's provider rows. */
export function expectedLookup(providers: readonly ProviderRecord[]): ExpectedLookup {
  const byName = new Map(providers.map((p) => [p.name, p.expectedStatuses ?? {}]));
  return (key) => {
    const list = byName.get(key.provider)?.[expectedKey(key)];
    return list ? list.filter(isExpectable) : [];
  };
}

/**
 * The counts as scoring sees them: each marked status moved from its status column and
 * `http_4xx` to `ok`, and remembered in `marked` (the safety net and the charts use it).
 * Linear, so it applies to minute rows, sums and differences alike. Returns `r` itself
 * when nothing is marked.
 */
export function applyExpected<T extends RollupCounts>(
  r: T,
  statuses: readonly ExpectableStatus[],
): T {
  if (statuses.length === 0 || !r.statusCounts) return r;
  const statusCounts = { ...r.statusCounts };
  const outcomes = { ...r.outcomes };
  const marked = r.marked ? { ...r.marked } : emptyStatusCounts();
  let moved = 0;
  for (const s of statuses) {
    const k = KEY_OF[s];
    const n = statusCounts[k] ?? 0;
    if (n <= 0) continue;
    statusCounts[k] = 0;
    marked[k] += n;
    moved += n;
  }
  if (moved === 0) return r;
  outcomes.http_4xx = Math.max(0, (outcomes.http_4xx ?? 0) - moved);
  outcomes.ok = (outcomes.ok ?? 0) + moved;
  const out: T = { ...r, statusCounts, outcomes, marked };
  if (typeof (r as { ok?: unknown }).ok === 'number')
    (out as unknown as { ok: number }).ok = (r as unknown as { ok: number }).ok + moved;
  return out;
}

/**
 * Safety net: a marked status whose share of calls exceeds max(80%, 4 × its normal share)
 * for this many minutes in a row opens a behaviour incident anyway ("400 (marked
 * expected) now 95% of calls, normally 10%"): everything answering 400 is not a business
 * answer any more.
 */
export const EXPECTED_SURGE_MINUTES = 10;
export const EXPECTED_SURGE_MIN_SHARE = 0.8;
export const EXPECTED_SURGE_FACTOR = 4;

export const surgeLimit = (normalShare: number) =>
  Math.max(EXPECTED_SURGE_MIN_SHARE, EXPECTED_SURGE_FACTOR * normalShare);

/** A marked status over its limit in one window. */
export interface ExpectedSurge {
  status: ExpectableStatus;
  /** Calls with that status in the window. */
  count: number;
  share: number;
  normalShare: number;
}

/**
 * The marked status most over its limit in this window, or null. Needs enough calls
 * (`minCalls`) and at least `minErrors` of them with the status, like every other rule.
 */
export function surgeIn(
  stats: { calls: number; marked?: StatusCounts },
  statuses: readonly ExpectableStatus[],
  normal: Partial<Record<string, number>> | undefined,
  t: { minCalls: number; minErrors: number },
): ExpectedSurge | null {
  if (statuses.length === 0 || !stats.marked || stats.calls < t.minCalls) return null;
  let best: ExpectedSurge | null = null;
  for (const status of statuses) {
    const count = stats.marked[KEY_OF[status]] ?? 0;
    if (count < t.minErrors) continue;
    const share = count / stats.calls;
    const normalShare = normal?.[String(status)] ?? 0;
    if (share <= surgeLimit(normalShare)) continue;
    if (!best || share - surgeLimit(normalShare) > best.share - surgeLimit(best.normalShare))
      best = { status, count, share, normalShare };
  }
  return best;
}
