import {
  LATENCY_BUCKET_COUNT,
  OUTCOMES,
  emptyHistogram,
  type Outcome,
  type RollupRow,
} from '@theirside/shared';

/** Outcome → rollups_1m column (they share names). */
export const OUTCOME_COLUMNS: readonly Outcome[] = OUTCOMES;

export const HIST_COLUMNS: readonly string[] = Array.from(
  { length: LATENCY_BUCKET_COUNT },
  (_, i) => `h${i}`,
);

/** Additive integer counter columns of rollups_1m, in a fixed order. */
export const COUNTER_COLUMNS: readonly string[] = [
  'total',
  ...OUTCOME_COLUMNS,
  'status_429',
  ...HIST_COLUMNS,
];

export const KEY_COLUMNS = ['environment', 'provider', 'endpoint', 'method'] as const;

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Map a rollups_1m-shaped SQL row (raw or summed) to RollupRow. */
export function rowToRollup(r: Row): RollupRow {
  const outcomes = {} as Record<Outcome, number>;
  for (const o of OUTCOME_COLUMNS) outcomes[o] = num(r[o]);
  const hist = emptyHistogram();
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) hist[i] = num(r[`h${i}`]);
  return {
    orgId: String(r.org_id ?? ''),
    projectId: String(r.project_id ?? ''),
    environment: String(r.environment ?? ''),
    provider: String(r.provider ?? ''),
    endpoint: String(r.endpoint ?? ''),
    method: String(r.method ?? ''),
    minute: r.minute instanceof Date ? r.minute.toISOString() : String(r.minute ?? ''),
    total: num(r.total),
    ok: num(r.ok),
    outcomes,
    status429: num(r.status_429),
    latencyHistogram: hist,
    latencySumMs: num(r.latency_sum_ms),
  };
}

/** `sum(col)::bigint AS col` for every counter, plus latency sum. */
export const SUM_SELECT = [
  ...COUNTER_COLUMNS.map((c) => `sum(${c})::bigint AS ${c}`),
  'sum(latency_sum_ms) AS latency_sum_ms',
].join(', ');
