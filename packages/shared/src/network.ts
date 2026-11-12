import type { Outcome, StatusCounts } from './outcomes.js';
import { OUTCOMES } from './outcomes.js';

/**
 * A `rollups_1m` row as the collector stores it (architecture §5.2).
 * Defined here so the network aggregate format below is derived from it.
 */
export interface RollupRow {
  orgId: string;
  projectId: string;
  environment: string;
  provider: string;
  endpoint: string;
  method: string;
  /** Minute start, ISO 8601 UTC. */
  minute: string;
  total: number;
  ok: number;
  outcomes: Record<Outcome, number>;
  status429: number;
  /** 3xx and the common 4xx one by one (collector 0.3.0+; missing: all 0). */
  statusCounts?: StatusCounts;
  /**
   * Of `ok`: 4xx answers the app marked expected in code (SDK `markExpected`), counted
   * as successful and not in `http_4xx` or `statusCounts` (collector 0.5.0+; missing: 0).
   */
  expected?: number;
  latencyHistogram: number[];
  latencySumMs: number;
}

/**
 * Network aggregate row (architecture §5.4): a rollup minus every tenant
 * identifier, plus a random per-install contributor id. Fixed now, used by a
 * later uplink. Only rows of catalog providers (public, known APIs) may ever be
 * converted; hosts found by auto-discovery and configured names never.
 */
export interface NetworkAggregateRow {
  contributorId: string;
  host: string;
  method: string;
  endpoint: string;
  minute: string;
  total: number;
  ok: number;
  outcomes: Record<Outcome, number>;
  status429: number;
  latencyHistogram: number[];
}

export interface ToNetworkRowOptions {
  contributorId: string;
  /** Public provider domain for this rollup's provider; null if not public. */
  publicHost: string | null;
}

/** Pure conversion; returns null when the provider has no public host. */
export function toNetworkAggregateRow(
  row: RollupRow,
  opts: ToNetworkRowOptions,
): NetworkAggregateRow | null {
  if (!opts.publicHost) return null;
  const outcomes = {} as Record<Outcome, number>;
  for (const o of OUTCOMES) outcomes[o] = row.outcomes[o] ?? 0;
  return {
    contributorId: opts.contributorId,
    host: opts.publicHost.toLowerCase(),
    method: row.method,
    endpoint: row.endpoint,
    minute: row.minute,
    total: row.total,
    ok: row.ok,
    outcomes,
    status429: row.status429,
    latencyHistogram: [...row.latencyHistogram],
  };
}
