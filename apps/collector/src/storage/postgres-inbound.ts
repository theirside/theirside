import type pg from 'pg';
import { COARSE_BUCKET_COUNT } from '@theirside/shared';
import { fineColumns, fineValues, mergeSet, prepared, readHistogram } from './columns.js';
import { parseSilenceProfile } from '../modules/scoring/silence.js';
import type {
  CandidateDelta,
  InboundBaseline,
  InboundKey,
  InboundQuery,
  InboundRollupRow,
  InboundStore,
  Tenant,
  WebhookCandidate,
  WebhookCandidateStatus,
  WebhookSource,
} from './types.js';
import { inboundKeyId } from './types.js';

type Queryable = pg.Pool | pg.PoolClient;
type Row = Record<string, unknown>;

/** Coarse histograms of rows from before collector 0.4 (NULL in newer rows; read and merged only). */
const D_COLUMNS = Array.from({ length: COARSE_BUCKET_COUNT }, (_, i) => `d${i}`);
const L_COLUMNS = Array.from({ length: COARSE_BUCKET_COUNT }, (_, i) => `l${i}`);
const COARSE_COLUMNS = [...D_COLUMNS, ...L_COLUMNS];
/** Additive integer counters of rollups_inbound_1m (migration 018), in a fixed order. */
const INT_COLUMNS = [
  'total',
  'accepted',
  'rejected',
  'status_3xx',
  'status_401',
  'status_403',
  'status_4xx',
  'status_5xx',
  'unanswered',
  'lag_count',
];
/** Fine histograms, one nullable column per bucket (migration 021). */
const DUR_COLUMNS = fineColumns('dur');
const LAG_COLUMNS = fineColumns('lag');
const HIST_COLUMNS = [...DUR_COLUMNS, ...LAG_COLUMNS];
const FLOAT_COLUMNS = ['duration_sum_ms', 'lag_sum_s'];
const KEY = ['environment', 'provider', 'endpoint'] as const;
const SUM_SELECT = [
  ...[...INT_COLUMNS, ...COARSE_COLUMNS, ...HIST_COLUMNS].map((c) => `sum(${c})::bigint AS ${c}`),
  ...FLOAT_COLUMNS.map((c) => `sum(${c}) AS ${c}`),
].join(', ');

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function toRow(r: Row): InboundRollupRow {
  const d = readHistogram(r, 'dur', 'd');
  const l = readHistogram(r, 'lag', 'l');
  return {
    environment: String(r.environment ?? ''),
    provider: String(r.provider ?? ''),
    endpoint: String(r.endpoint ?? ''),
    minute: r.minute instanceof Date ? r.minute.toISOString() : String(r.minute ?? ''),
    total: num(r.total),
    accepted: num(r.accepted),
    rejected: num(r.rejected),
    status3xx: num(r.status_3xx),
    status401: num(r.status_401),
    status403: num(r.status_403),
    status4xx: num(r.status_4xx),
    status5xx: num(r.status_5xx),
    unanswered: num(r.unanswered),
    durationHistogram: d,
    durationSumMs: num(r.duration_sum_ms),
    lagCount: num(r.lag_count),
    lagSumS: num(r.lag_sum_s),
    lagHistogram: l,
  };
}

function values(r: InboundRollupRow): {
  ints: number[];
  hists: (number | null)[];
  floats: number[];
} {
  return {
    ints: [
      r.total,
      r.accepted,
      r.rejected,
      r.status3xx,
      r.status401,
      r.status403,
      r.status4xx,
      r.status5xx,
      r.unanswered,
      r.lagCount,
    ],
    hists: [...fineValues(r.durationHistogram), ...fineValues(r.lagHistogram)],
    floats: [r.durationSumMs, r.lagSumS],
  };
}

function where(tenant: Tenant, q: InboundQuery, params: unknown[]): string {
  params.push(tenant.orgId, tenant.projectId, q.from, q.to);
  const parts = ['org_id = $1', 'project_id = $2', 'minute >= $3', 'minute < $4'];
  for (const k of KEY) {
    if (q[k] !== undefined) {
      params.push(q[k]);
      parts.push(`${k} = $${params.length}`);
    }
  }
  return parts.join(' AND ');
}

function rowToSource(r: Row): WebhookSource {
  return {
    environment: r.environment as string,
    provider: r.provider as string,
    endpoint: r.endpoint as string,
    firstSeenAt: r.first_seen_at as Date,
    lastDeliveryAt: r.last_delivery_at as Date,
    lastService: (r.last_service as string | null) ?? null,
    expectedQuiet: Boolean(r.expected_quiet),
    silenceForced: Boolean(r.silence_forced),
  };
}

/** Inbound webhook rollups, sources and baselines (migration 018). */
export class PgInboundStore implements InboundStore {
  constructor(private readonly db: Queryable) {}

  async upsertRollups(tenant: Tenant, rows: InboundRollupRow[]): Promise<void> {
    if (rows.length === 0) return;
    const sorted = [...rows].sort((a, b) =>
      `${inboundKeyId(a)}\u0000${a.minute}`.localeCompare(`${inboundKeyId(b)}\u0000${b.minute}`),
    );
    const names = [...KEY, 'minute', ...INT_COLUMNS, ...HIST_COLUMNS, ...FLOAT_COLUMNS];
    const cols: unknown[][] = names.map(() => []);
    for (const r of sorted) {
      const v = values(r);
      [r.environment, r.provider, r.endpoint, r.minute, ...v.ints, ...v.hists, ...v.floats].forEach(
        (x, i) => cols[i]!.push(x),
      );
    }
    const types = [
      ...KEY.map(() => 'text[]'),
      'timestamptz[]',
      ...INT_COLUMNS.map(() => 'int[]'),
      ...HIST_COLUMNS.map(() => 'int[]'),
      ...FLOAT_COLUMNS.map(() => 'float8[]'),
    ];
    const updates = mergeSet(
      'rollups_inbound_1m',
      [...INT_COLUMNS, ...HIST_COLUMNS, ...FLOAT_COLUMNS],
      HIST_COLUMNS,
    );
    await this.db.query(
      prepared(
        `INSERT INTO rollups_inbound_1m (org_id, project_id, ${names.join(', ')})
       SELECT $1, $2, u.* FROM unnest(${types.map((t, i) => `$${i + 3}::${t}`).join(', ')}) AS u
       ON CONFLICT (org_id, project_id, environment, provider, endpoint, minute)
       DO UPDATE SET ${updates}`,
        [tenant.orgId, tenant.projectId, ...cols],
      ),
    );
  }

  async query(tenant: Tenant, q: InboundQuery) {
    const params: unknown[] = [];
    const { rows } = await this.db.query(
      prepared(
        `SELECT * FROM rollups_inbound_1m WHERE ${where(tenant, q, params)} ORDER BY minute`,
        params,
      ),
    );
    return rows.map(toRow);
  }

  async aggregateByKey(tenant: Tenant, q: InboundQuery) {
    const params: unknown[] = [];
    const { rows } = await this.db.query(
      prepared(
        `SELECT environment, provider, endpoint, min(minute) AS minute, max(minute) AS last_minute,
              ${SUM_SELECT}
         FROM rollups_inbound_1m WHERE ${where(tenant, q, params)}
        GROUP BY environment, provider, endpoint`,
        params,
      ),
    );
    return rows.map((r: Row) => ({
      ...toRow(r),
      firstMinute: (r.minute as Date).toISOString(),
      lastMinute: (r.last_minute as Date).toISOString(),
    }));
  }

  async series(tenant: Tenant, q: InboundQuery & { bucketMinutes: number }) {
    const params: unknown[] = [];
    const w = where(tenant, q, params);
    params.push(q.bucketMinutes * 60);
    const b = `$${params.length}`;
    const { rows } = await this.db.query(
      `SELECT to_timestamp(floor(extract(epoch FROM minute) / ${b}) * ${b}) AS minute, ${SUM_SELECT}
         FROM rollups_inbound_1m WHERE ${w}
        GROUP BY 1 ORDER BY 1`,
      params,
    );
    return rows.map(toRow);
  }

  async hourly(tenant: Tenant, key: InboundKey, from: Date, to: Date) {
    const { rows } = await this.db.query(
      prepared(
        `SELECT date_trunc('hour', minute) AS hour, count(*)::int AS minutes, ${SUM_SELECT}
         FROM rollups_inbound_1m
        WHERE org_id = $1 AND project_id = $2 AND environment = $3 AND provider = $4
          AND endpoint = $5 AND minute >= $6 AND minute < $7
        GROUP BY 1 ORDER BY 1`,
        [tenant.orgId, tenant.projectId, key.environment, key.provider, key.endpoint, from, to],
      ),
    );
    return rows.map((r: Row) => ({
      ...toRow({
        ...r,
        minute: r.hour,
        environment: key.environment,
        provider: key.provider,
        endpoint: key.endpoint,
      }),
      hour: r.hour as Date,
      minutes: num(r.minutes),
    }));
  }

  async gaps(tenant: Tenant, key: InboundKey, from: Date, to: Date) {
    const { rows } = await this.db.query(
      prepared(
        `SELECT prev + interval '1 minute' AS start,
              (extract(epoch FROM minute - prev) / 60)::int - 1 AS minutes
         FROM (SELECT minute, lag(minute) OVER (ORDER BY minute) AS prev
                 FROM rollups_inbound_1m
                WHERE org_id = $1 AND project_id = $2 AND environment = $3 AND provider = $4
                  AND endpoint = $5 AND minute >= $6 AND minute < $7 AND total > 0) x
        WHERE minute - prev > interval '1 minute'
        ORDER BY 1`,
        [tenant.orgId, tenant.projectId, key.environment, key.provider, key.endpoint, from, to],
      ),
    );
    return rows.map((r: Row) => ({ start: r.start as Date, minutes: num(r.minutes) }));
  }

  async countIn(tenant: Tenant, key: InboundKey, ranges: { from: Date; to: Date }[]) {
    if (ranges.length === 0) return [];
    const { rows } = await this.db.query(
      `SELECT r.i, coalesce(sum(x.total), 0)::bigint AS count
         FROM unnest($6::timestamptz[], $7::timestamptz[]) WITH ORDINALITY AS r(f, t, i)
         LEFT JOIN rollups_inbound_1m x
           ON x.org_id = $1 AND x.project_id = $2 AND x.environment = $3 AND x.provider = $4
          AND x.endpoint = $5 AND x.minute >= r.f AND x.minute < r.t
        GROUP BY r.i ORDER BY r.i`,
      [
        tenant.orgId,
        tenant.projectId,
        key.environment,
        key.provider,
        key.endpoint,
        ranges.map((r) => r.from),
        ranges.map((r) => r.to),
      ],
    );
    return rows.map((r: Row) => num(r.count));
  }

  async lastDeliveryMinutes(tenant: Tenant, since: Date) {
    const { rows } = await this.db.query(
      `SELECT environment, provider, endpoint, max(minute) AS last
         FROM rollups_inbound_1m
        WHERE org_id = $1 AND project_id = $2 AND minute >= $3 AND total > 0
        GROUP BY environment, provider, endpoint`,
      [tenant.orgId, tenant.projectId, since],
    );
    return new Map(
      rows.map((r: Row) => [inboundKeyId(r as unknown as InboundKey), r.last as Date]),
    );
  }

  async activeKeys(from: Date) {
    const { rows } = await this.db.query(
      // the sources table, not 60 days of rollups: one row per source with its last delivery
      `SELECT org_id, project_id, environment, provider, endpoint
         FROM webhook_sources WHERE last_delivery_at >= $1`,
      [from],
    );
    return rows.map((r: Row) => ({
      orgId: r.org_id as string,
      projectId: r.project_id as string,
      environment: r.environment as string,
      provider: r.provider as string,
      endpoint: r.endpoint as string,
    }));
  }

  async deleteBefore(before: Date, tenant?: Tenant) {
    const res = tenant
      ? await this.db.query(
          `DELETE FROM rollups_inbound_1m WHERE org_id = $1 AND project_id = $2 AND minute < $3`,
          [tenant.orgId, tenant.projectId, before],
        )
      : await this.db.query(`DELETE FROM rollups_inbound_1m WHERE minute < $1`, [before]);
    return res.rowCount ?? 0;
  }

  async moveProvider(tenant: Tenant, from: string, to: string) {
    const p = [tenant.orgId, tenant.projectId, from, to];
    const all = [...INT_COLUMNS, ...COARSE_COLUMNS, ...HIST_COLUMNS, ...FLOAT_COLUMNS];
    await this.db.query(
      `INSERT INTO rollups_inbound_1m (org_id, project_id, environment, provider, endpoint, minute, ${all.join(', ')})
       SELECT org_id, project_id, environment, $4, endpoint, minute, ${all.join(', ')}
         FROM rollups_inbound_1m WHERE org_id = $1 AND project_id = $2 AND provider = $3
       ON CONFLICT (org_id, project_id, environment, provider, endpoint, minute)
       DO UPDATE SET ${mergeSet('rollups_inbound_1m', all, [...COARSE_COLUMNS, ...HIST_COLUMNS])}`,
      p,
    );
    await this.db.query(
      `DELETE FROM rollups_inbound_1m WHERE org_id = $1 AND project_id = $2 AND provider = $3`,
      p.slice(0, 3),
    );
    await this.db.query(
      `INSERT INTO webhook_sources (org_id, project_id, environment, provider, endpoint, first_seen_at,
                                    last_delivery_at, last_service, expected_quiet, silence_forced)
       SELECT org_id, project_id, environment, $4, endpoint, first_seen_at, last_delivery_at,
              last_service, expected_quiet, silence_forced
         FROM webhook_sources WHERE org_id = $1 AND project_id = $2 AND provider = $3
       ON CONFLICT (org_id, project_id, environment, provider, endpoint) DO UPDATE SET
         first_seen_at = LEAST(webhook_sources.first_seen_at, EXCLUDED.first_seen_at),
         last_delivery_at = GREATEST(webhook_sources.last_delivery_at, EXCLUDED.last_delivery_at),
         expected_quiet = webhook_sources.expected_quiet OR EXCLUDED.expected_quiet,
         silence_forced = webhook_sources.silence_forced OR EXCLUDED.silence_forced`,
      p,
    );
    await this.db.query(
      `DELETE FROM webhook_sources WHERE org_id = $1 AND project_id = $2 AND provider = $3`,
      p.slice(0, 3),
    );
    await this.db.query(
      `DELETE FROM inbound_baselines WHERE org_id = $1 AND project_id = $2 AND provider IN ($3, $4)`,
      p,
    );
    // a confirmed discovered route keeps pointing at the merged provider
    await this.db.query(
      `UPDATE webhook_candidates SET provider = $4
        WHERE org_id = $1 AND project_id = $2 AND provider = $3`,
      p,
    );
  }

  async recordCandidates(tenant: Tenant, rows: CandidateDelta[], maxPending: number) {
    if (rows.length === 0) return 0;
    const t = [tenant.orgId, tenant.projectId];
    // per route: latest report and total deliveries in the batch
    const byRoute = new Map<string, CandidateDelta & { firstAt: Date }>();
    for (const r of rows) {
      const cur = byRoute.get(r.endpoint);
      if (!cur) byRoute.set(r.endpoint, { ...r, firstAt: r.lastAt });
      else {
        cur.deliveries += r.deliveries;
        if (r.lastAt < cur.firstAt) cur.firstAt = r.lastAt;
        if (r.lastAt > cur.lastAt)
          Object.assign(cur, { ...r, deliveries: cur.deliveries, firstAt: cur.firstAt });
      }
    }
    const routes = [...byRoute.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
    const { rows: existing } = await this.db.query(
      `UPDATE webhook_candidates c SET
          last_seen_at = GREATEST(c.last_seen_at, u.at),
          last_service = CASE WHEN u.at >= c.last_seen_at THEN u.svc ELSE c.last_service END,
          method = CASE WHEN u.at >= c.last_seen_at THEN u.m ELSE c.method END,
          suggested_name = COALESCE(c.suggested_name, u.name)
         FROM unnest($3::text[], $4::timestamptz[], $5::text[], $6::text[], $7::text[])
              AS u(ep, at, svc, m, name)
        WHERE c.org_id = $1 AND c.project_id = $2 AND c.endpoint = u.ep
        RETURNING c.endpoint`,
      [
        ...t,
        routes.map((r) => r.endpoint),
        routes.map((r) => r.lastAt),
        routes.map((r) => r.service),
        routes.map((r) => r.method),
        routes.map((r) => r.suggestedName),
      ],
    );
    const known = new Set(existing.map((r: { endpoint: string }) => r.endpoint));
    const fresh = routes.filter((r) => !known.has(r.endpoint));
    let skipped = 0;
    if (fresh.length > 0) {
      const { rows: c } = await this.db.query(
        `SELECT count(*)::int AS n FROM webhook_candidates
          WHERE org_id = $1 AND project_id = $2 AND status = 'pending'`,
        t,
      );
      const room = Math.max(0, maxPending - (c[0]?.n ?? 0));
      const add = fresh.slice(0, room);
      skipped = fresh.length - add.length;
      if (add.length > 0)
        await this.db.query(
          `INSERT INTO webhook_candidates (org_id, project_id, endpoint, method, suggested_name,
                                           first_seen_at, last_seen_at, last_service)
           SELECT $1, $2, u.ep, u.m, u.name, u.first, u.at, u.svc
             FROM unnest($3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[],
                         $8::text[]) AS u(ep, m, name, first, at, svc)
           ON CONFLICT (org_id, project_id, endpoint) DO NOTHING`,
          [
            ...t,
            add.map((r) => r.endpoint),
            add.map((r) => r.method),
            add.map((r) => r.suggestedName),
            add.map((r) => r.firstAt),
            add.map((r) => r.lastAt),
            add.map((r) => r.service),
          ],
        );
    }
    // day counts for the routes that exist now (dropped routes count nothing)
    const sorted = [...rows].sort(
      (a, b) => a.endpoint.localeCompare(b.endpoint) || a.day.localeCompare(b.day),
    );
    await this.db.query(
      `INSERT INTO webhook_candidate_days (org_id, project_id, endpoint, day, deliveries)
       SELECT $1, $2, u.ep, u.day, sum(u.n)
         FROM unnest($3::text[], $4::date[], $5::int[]) AS u(ep, day, n)
         JOIN webhook_candidates c
           ON c.org_id = $1 AND c.project_id = $2 AND c.endpoint = u.ep
        GROUP BY u.ep, u.day
       ON CONFLICT (org_id, project_id, endpoint, day)
       DO UPDATE SET deliveries = webhook_candidate_days.deliveries + EXCLUDED.deliveries`,
      [
        ...t,
        sorted.map((r) => r.endpoint),
        sorted.map((r) => r.day),
        sorted.map((r) => r.deliveries),
      ],
    );
    return skipped;
  }

  async listCandidates(tenant: Tenant, today: Date): Promise<WebhookCandidate[]> {
    const from = new Date(today.getTime() - 6 * 86_400_000);
    const { rows } = await this.db.query(
      `SELECT c.*, COALESCE(d.n, 0)::int AS deliveries_7d, COALESCE(d.days, 0)::int AS active_days
         FROM webhook_candidates c
         LEFT JOIN (
           SELECT endpoint, sum(deliveries) AS n, count(*) AS days
             FROM webhook_candidate_days
            WHERE org_id = $1 AND project_id = $2 AND day >= $3::date
            GROUP BY endpoint
         ) d ON d.endpoint = c.endpoint
        WHERE c.org_id = $1 AND c.project_id = $2
        ORDER BY c.status, c.last_seen_at DESC, c.endpoint`,
      [tenant.orgId, tenant.projectId, from.toISOString().slice(0, 10)],
    );
    return rows.map((r: Row) => ({
      endpoint: r.endpoint as string,
      method: r.method as string,
      suggestedName: (r.suggested_name as string | null) ?? null,
      status: r.status as WebhookCandidateStatus,
      provider: (r.provider as string | null) ?? null,
      firstSeenAt: r.first_seen_at as Date,
      lastSeenAt: r.last_seen_at as Date,
      lastService: (r.last_service as string | null) ?? null,
      decidedAt: (r.decided_at as Date | null) ?? null,
      decidedBy: (r.decided_by as string | null) ?? null,
      deliveries7d: r.deliveries_7d as number,
      activeDays: r.active_days as number,
    }));
  }

  async decideCandidate(
    tenant: Tenant,
    endpoint: string,
    d: { status: WebhookCandidateStatus; provider: string | null; by: string | null; at: Date },
  ) {
    const res = await this.db.query(
      `UPDATE webhook_candidates
          SET status = $4, provider = $5, decided_by = $6,
              decided_at = CASE WHEN $4 = 'pending' THEN NULL ELSE $7::timestamptz END
        WHERE org_id = $1 AND project_id = $2 AND endpoint = $3`,
      [
        tenant.orgId,
        tenant.projectId,
        endpoint,
        d.status,
        d.status === 'confirmed' ? d.provider : null,
        d.status === 'pending' ? null : d.by,
        d.at,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async candidateRoutes(tenant: Tenant) {
    const { rows } = await this.db.query(
      `SELECT endpoint, status, provider FROM webhook_candidates
        WHERE org_id = $1 AND project_id = $2 AND status <> 'pending'
        ORDER BY endpoint`,
      [tenant.orgId, tenant.projectId],
    );
    return {
      confirmed: rows
        .filter((r: Row) => r.status === 'confirmed')
        .map((r: Row) => ({ path: r.endpoint as string, provider: r.provider as string })),
      ignored: rows
        .filter((r: Row) => r.status === 'ignored')
        .map((r: Row) => r.endpoint as string),
    };
  }

  async pruneCandidates(before: Date) {
    await this.db.query(`DELETE FROM webhook_candidate_days WHERE day < $1::date`, [
      before.toISOString().slice(0, 10),
    ]);
    // pending routes nobody decided on and nothing reported since: room for new ones under the cap
    await this.db.query(
      `DELETE FROM webhook_candidates WHERE status = 'pending' AND last_seen_at < $1`,
      [before],
    );
  }

  async listSources(tenant: Tenant) {
    const { rows } = await this.db.query(
      `SELECT * FROM webhook_sources WHERE org_id = $1 AND project_id = $2
        ORDER BY provider, endpoint, environment`,
      [tenant.orgId, tenant.projectId],
    );
    return rows.map(rowToSource);
  }

  async touchSources(
    tenant: Tenant,
    rows: (InboundKey & { lastDeliveryAt: Date; service: string })[],
  ) {
    if (rows.length === 0) return;
    const sorted = [...rows].sort((a, b) => inboundKeyId(a).localeCompare(inboundKeyId(b)));
    await this.db.query(
      `INSERT INTO webhook_sources (org_id, project_id, environment, provider, endpoint, first_seen_at,
                                    last_delivery_at, last_service)
       SELECT $1, $2, u.e, u.p, u.ep, u.at, u.at, u.svc
         FROM unnest($3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::text[])
              AS u(e, p, ep, at, svc)
       ON CONFLICT (org_id, project_id, environment, provider, endpoint) DO UPDATE SET
         last_delivery_at = GREATEST(webhook_sources.last_delivery_at, EXCLUDED.last_delivery_at),
         last_service = CASE WHEN EXCLUDED.last_delivery_at >= webhook_sources.last_delivery_at
                             THEN EXCLUDED.last_service ELSE webhook_sources.last_service END`,
      [
        tenant.orgId,
        tenant.projectId,
        sorted.map((r) => r.environment),
        sorted.map((r) => r.provider),
        sorted.map((r) => r.endpoint),
        sorted.map((r) => r.lastDeliveryAt),
        sorted.map((r) => r.service),
      ],
    );
  }

  async setExpectedQuiet(tenant: Tenant, key: InboundKey, quiet: boolean) {
    const res = await this.db.query(
      `UPDATE webhook_sources SET expected_quiet = $6
        WHERE org_id = $1 AND project_id = $2 AND environment = $3 AND provider = $4 AND endpoint = $5`,
      [tenant.orgId, tenant.projectId, key.environment, key.provider, key.endpoint, quiet],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setSilenceForced(tenant: Tenant, key: InboundKey, forced: boolean) {
    const res = await this.db.query(
      `UPDATE webhook_sources SET silence_forced = $6
        WHERE org_id = $1 AND project_id = $2 AND environment = $3 AND provider = $4 AND endpoint = $5`,
      [tenant.orgId, tenant.projectId, key.environment, key.provider, key.endpoint, forced],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getBaselines(tenant: Tenant): Promise<InboundBaseline[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM inbound_baselines WHERE org_id = $1 AND project_id = $2`,
      [tenant.orgId, tenant.projectId],
    );
    return rows.map((r: Row) => ({
      environment: r.environment as string,
      provider: r.provider as string,
      endpoint: r.endpoint as string,
      rejectionRate: Number(r.rejection_rate),
      p50Ms: r.p50_ms === null ? null : Number(r.p50_ms),
      p95Ms: r.p95_ms === null ? null : Number(r.p95_ms),
      lagP95S: r.lag_p95_s === null ? null : Number(r.lag_p95_s),
      sampleSize: num(r.sample_size),
      historyMinutes: num(r.history_minutes),
      learning: Boolean(r.learning),
      silence: parseSilenceProfile(r.silence),
      ...(r.model && typeof r.model === 'object' && 'rho' in (r.model as object)
        ? { model: r.model as InboundBaseline['model'] }
        : {}),
      computedAt: r.computed_at as Date,
    }));
  }

  async upsertBaselines(tenant: Tenant, baselines: InboundBaseline[]) {
    for (const b of baselines) {
      await this.db.query(
        `INSERT INTO inbound_baselines (org_id, project_id, environment, provider, endpoint, rejection_rate,
                                        p50_ms, p95_ms, lag_p95_s, sample_size, history_minutes, learning,
                                        silence, computed_at, model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (org_id, project_id, environment, provider, endpoint) DO UPDATE SET
           rejection_rate = EXCLUDED.rejection_rate, p50_ms = EXCLUDED.p50_ms, p95_ms = EXCLUDED.p95_ms,
           lag_p95_s = EXCLUDED.lag_p95_s, sample_size = EXCLUDED.sample_size,
           history_minutes = EXCLUDED.history_minutes, learning = EXCLUDED.learning,
           silence = EXCLUDED.silence, computed_at = EXCLUDED.computed_at, model = EXCLUDED.model`,
        [
          tenant.orgId,
          tenant.projectId,
          b.environment,
          b.provider,
          b.endpoint,
          b.rejectionRate,
          b.p50Ms,
          b.p95Ms,
          b.lagP95S,
          b.sampleSize,
          b.historyMinutes,
          b.learning,
          JSON.stringify(b.silence),
          b.computedAt,
          JSON.stringify(b.model ?? {}),
        ],
      );
    }
  }
}
