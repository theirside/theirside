import { createHash } from 'node:crypto';
import {
  COARSE_BUCKET_COUNT,
  LATENCY_BUCKET_COUNT,
  OUTCOMES,
  addCoarse,
  emptyHistogram,
  STATUS_COUNT_KEYS,
  type Outcome,
  type RollupRow,
  type StatusCounts,
} from '@theirside/shared';

/** Outcome → rollups_1m column (they share names). */
export const OUTCOME_COLUMNS: readonly Outcome[] = OUTCOMES;

/**
 * The coarse latency histogram of rows written before collector 0.4 (h0..h17, powers of
 * two; NULL in newer rows). Read and merged, never written: new rows carry `LATENCY_COLUMNS`.
 */
export const COARSE_HIST_COLUMNS: readonly string[] = Array.from(
  { length: COARSE_BUCKET_COUNT },
  (_, i) => `h${i}`,
);

/** StatusCounts key → rollups_1m column (migration 016). */
export const STATUS_COLUMNS: readonly [keyof StatusCounts, string][] = STATUS_COUNT_KEYS.map(
  (k) => [k, k === 's3xx' ? 'status_3xx' : `status_${k.slice(1)}`],
);

/** Additive integer counter columns of rollups_1m, in a fixed order (histograms apart). */
export const COUNTER_COLUMNS: readonly string[] = [
  'total',
  ...OUTCOME_COLUMNS,
  'status_429',
  ...STATUS_COLUMNS.map(([, c]) => c),
];

/**
 * The fine latency histogram (migration 021): one nullable integer column per bucket
 * of packages/shared/src/histogram.ts, NULL for an empty bucket (only a null-bitmap
 * bit), so a row stores the buckets it uses and sums are plain `sum()` per column.
 */
export const fineColumns = (prefix: string): readonly string[] =>
  Array.from({ length: LATENCY_BUCKET_COUNT }, (_, i) => `${prefix}${i}`);
export const LATENCY_COLUMNS = fineColumns('lat');

/** Every additive column, for moving rows between keys (`mergeSet` adds them up). */
export const MERGE_COLUMNS: readonly string[] = [
  ...COUNTER_COLUMNS,
  ...COARSE_HIST_COLUMNS,
  ...LATENCY_COLUMNS,
  'latency_sum_ms',
];

/**
 * `ON CONFLICT … DO UPDATE SET` adding `cols` of `table`: counters by +, nullable
 * histogram buckets (`nullable`) staying NULL only when both sides are.
 */
export function mergeSet(
  table: string,
  cols: readonly string[],
  nullable: readonly string[],
): string {
  const n = new Set(nullable);
  return cols
    .map((c) =>
      n.has(c)
        ? `${c} = CASE WHEN ${table}.${c} IS NULL THEN EXCLUDED.${c} WHEN EXCLUDED.${c} IS NULL THEN ${table}.${c} ELSE ${table}.${c} + EXCLUDED.${c} END`
        : `${c} = ${table}.${c} + EXCLUDED.${c}`,
    )
    .join(', ');
}

/** A histogram's bucket values for its columns: NULL for empty buckets. */
export const fineValues = (hist: readonly number[]): (number | null)[] =>
  Array.from({ length: LATENCY_BUCKET_COUNT }, (_, i) => (hist[i] ? hist[i]! : null));

/** Fine histogram of a row: its `fine`0..129 columns plus its coarse columns `coarse`0..17 spread out. */
export function readHistogram(r: Row, fine: string, coarsePrefix: string): number[] {
  const hist = emptyHistogram();
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) {
    const v = r[`${fine}${i}`];
    if (v !== null && v !== undefined) hist[i] = Number(v);
  }
  let any = false;
  const coarse = new Array<number>(COARSE_BUCKET_COUNT).fill(0);
  for (let i = 0; i < COARSE_BUCKET_COUNT; i++) {
    const v = r[`${coarsePrefix}${i}`];
    if (v !== null && v !== undefined && Number(v) !== 0) {
      coarse[i] = Number(v);
      any = true;
    }
  }
  return any ? addCoarse(hist, coarse) : hist;
}

export const KEY_COLUMNS = ['environment', 'provider', 'endpoint', 'method'] as const;

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Map a rollups_1m-shaped SQL row (raw or summed) to RollupRow. */
export function rowToRollup(r: Row): RollupRow {
  const outcomes = {} as Record<Outcome, number>;
  for (const o of OUTCOME_COLUMNS) outcomes[o] = num(r[o]);
  const hist = readHistogram(r, 'lat', 'h');
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

/** Sums of every counter and histogram bucket (fine and coarse), and the latency sum. */
export const SUM_SELECT = [
  ...[...COUNTER_COLUMNS, ...COARSE_HIST_COLUMNS, ...LATENCY_COLUMNS].map(
    (c) => `sum(${c})::bigint AS ${c}`,
  ),
  'sum(latency_sum_ms) AS latency_sum_ms',
].join(', ');

/**
 * A named (prepared) statement: Postgres plans it once per connection instead of on
 * every call, which matters for the wide rollup tables (planning a 150-column upsert or
 * window read took longer than running it). The name is a hash of the text.
 */
export const prepared = (text: string, values: unknown[]) => ({
  name: `s_${createHash('sha1').update(text).digest('hex').slice(0, 20)}`,
  text,
  values,
});
