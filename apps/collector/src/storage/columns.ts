import {
  LATENCY_BUCKET_COUNT,
  OUTCOMES,
  emptyHistogram,
  STATUS_COUNT_KEYS,
  type Outcome,
  type RollupRow,
  type StatusCounts,
} from '@theirside/shared';

/** Outcome → rollups_1m column (they share names). */
export const OUTCOME_COLUMNS: readonly Outcome[] = OUTCOMES;

export const HIST_COLUMNS: readonly string[] = Array.from(
  { length: LATENCY_BUCKET_COUNT },
  (_, i) => `h${i}`,
);

/** Additive integer counter columns of rollups_1m, in a fixed order. */
/** StatusCounts key → rollups_1m column (migration 016). */
export const STATUS_COLUMNS: readonly [keyof StatusCounts, string][] = STATUS_COUNT_KEYS.map(
  (k) => [k, k === 's3xx' ? 'status_3xx' : `status_${k.slice(1)}`],
);

export const COUNTER_COLUMNS: readonly string[] = [
  'total',
  ...OUTCOME_COLUMNS,
  'status_429',
  ...HIST_COLUMNS,
  ...STATUS_COLUMNS.map(([, c]) => c),
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
    statusCounts: Object.fromEntries(
      STATUS_COLUMNS.map(([k, c]) => [k, num(r[c])]),
    ) as unknown as StatusCounts,
    latencyHistogram: hist,
    latencySumMs: num(r.latency_sum_ms),
  };
}

/** `sum(col)::bigint AS col` for every counter, plus latency sum. */
export const SUM_SELECT = [
  ...COUNTER_COLUMNS.map((c) => `sum(${c})::bigint AS ${c}`),
  'sum(latency_sum_ms) AS latency_sum_ms',
].join(', ');
