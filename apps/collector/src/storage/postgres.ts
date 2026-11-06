import pg from 'pg';
import { PgAuthStore } from './postgres-auth.js';
import {
  COUNTER_COLUMNS,
  KEY_COLUMNS,
  STATUS_COLUMNS,
  SUM_SELECT,
  rowToRollup,
} from './columns.js';
import type {
  ServiceTemplate,
  SdkProcessRecord,
  EndpointMove,
  AlertChannelInput,
  AlertChannelRecord,
  AlertDelivery,
  ApiKeyRecord,
  Baseline,
  ConfigStore,
  EventSample,
  EventStore,
  Incident,
  IncidentListQuery,
  IncidentStore,
  MembershipRecord,
  ProviderInput,
  DiscoveredHost,
  ProviderRecord,
  RollupDelta,
  RollupKey,
  RollupQuery,
  RollupStore,
  SdkHeartbeat,
  SdkInstanceRecord,
  StatusPageRecord,
  Storage,
  StoredEvent,
  Tenant,
  UsageStore,
} from './types.js';
import { newId } from '../util/ids.js';

type Queryable = pg.Pool | pg.PoolClient;
type Row = Record<string, unknown>;

// Postgres returns bigint (int8) as string by default; counts here fit in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));

/** Errors that mean "storage is unavailable" (→ 503), as opposed to bad input. */
export function isStorageUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (!e) return false;
  if (typeof e.code === 'string') {
    if (
      ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN'].includes(
        e.code,
      )
    )
      return true;
    // 08xxx connection exceptions, 53xxx insufficient resources, 57Pxx operator intervention
    if (/^(08|53|57P)/.test(e.code)) return true;
  }
  return /Connection terminated|timeout exceeded when trying to connect|connection error|Client has encountered a connection error/i.test(
    e.message ?? '',
  );
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function partitionName(day: string): string {
  return `events_${day.replaceAll('-', '')}`;
}

// ------------------------------------------------------------------ events

class PgEventStore implements EventStore {
  constructor(private readonly db: Queryable) {}

  async moveProvider(tenant: Tenant, from: string, to: string) {
    const { rowCount } = await this.db.query(
      `UPDATE events SET provider = $4 WHERE org_id = $1 AND project_id = $2 AND provider = $3`,
      [tenant.orgId, tenant.projectId, from, to],
    );
    return rowCount ?? 0;
  }

  async moveEndpoint(tenant: Tenant, m: EndpointMove) {
    const { rowCount } = await this.db.query(
      `UPDATE events SET endpoint = $6
        WHERE org_id = $1 AND project_id = $2 AND provider = $3 AND method = $4 AND endpoint = $5`,
      [tenant.orgId, tenant.projectId, m.provider, m.method, m.from, m.to],
    );
    return rowCount ?? 0;
  }

  async insert(tenant: Tenant, receivedAt: Date, events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    const cols: unknown[][] = Array.from({ length: 14 }, () => []);
    for (const e of events) {
      cols[0]!.push(e.ts);
      cols[1]!.push(e.service);
      cols[2]!.push(e.environment);
      cols[3]!.push(e.sdkVersion);
      cols[4]!.push(e.provider);
      cols[5]!.push(e.host);
      cols[6]!.push(e.method);
      cols[7]!.push(e.endpoint);
      cols[8]!.push(e.status);
      cols[9]!.push(e.durationMs);
      cols[10]!.push(e.outcome);
      cols[11]!.push(e.errorCode);
      cols[12]!.push(e.correlationId);
      cols[13]!.push(e.providerRequestId);
    }
    const sql = `
      INSERT INTO events (org_id, project_id, received_at, ts, service, environment, sdk_version, provider,
                          host, method, endpoint, status, duration_ms, outcome, error_code, correlation_id,
                          provider_request_id)
      SELECT $1, $2, $3, u.*
      FROM unnest($4::timestamptz[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
                  $11::text[], $12::smallint[], $13::real[], $14::text[], $15::text[], $16::text[], $17::text[]) AS u`;
    const params = [tenant.orgId, tenant.projectId, receivedAt, ...cols];
    try {
      await this.db.query(sql, params);
    } catch (err) {
      // no partition for this day yet (e.g. scheduler not run): create it and retry once
      if (
        (err as { code?: string }).code === '23514' &&
        /no partition/i.test(String((err as Error).message))
      ) {
        await this.ensurePartitions(receivedAt, 1);
        await this.db.query(sql, params);
        return;
      }
      throw err;
    }
  }

  async sampleFailures(
    tenant: Tenant,
    q: {
      environment: string;
      provider: string;
      endpoints?: { endpoint: string; method: string }[];
      since: Date;
      limit: number;
    },
  ): Promise<EventSample[]> {
    const params: unknown[] = [
      tenant.orgId,
      tenant.projectId,
      q.environment,
      q.provider,
      q.since,
      q.limit,
    ];
    let endpointFilter = '';
    if (q.endpoints && q.endpoints.length > 0) {
      params.push(
        q.endpoints.map((e) => e.endpoint),
        q.endpoints.map((e) => e.method),
      );
      endpointFilter = `AND (endpoint, method) IN (SELECT * FROM unnest($7::text[], $8::text[]))`;
    }
    const { rows } = await this.db.query(
      `SELECT ts, endpoint, method, outcome, status, error_code, provider_request_id, correlation_id
         FROM events
        WHERE org_id = $1 AND project_id = $2 AND environment = $3 AND provider = $4
          AND received_at >= $5 AND ts >= $5 AND outcome NOT IN ('ok', 'aborted')
          ${endpointFilter}
        ORDER BY (provider_request_id IS NULL), ts DESC
        LIMIT $6`,
      params,
    );
    return rows.map((r: Row) => ({
      ts: r.ts as Date,
      endpoint: r.endpoint as string,
      method: r.method as string,
      outcome: r.outcome as EventSample['outcome'],
      status: (r.status as number | null) ?? null,
      errorCode: (r.error_code as string | null) ?? null,
      providerRequestId: (r.provider_request_id as string | null) ?? null,
      correlationId: (r.correlation_id as string | null) ?? null,
    }));
  }

  async ensurePartitions(from: Date, days: number): Promise<string[]> {
    const existing = new Set(await this.listPartitions());
    const created: string[] = [];
    const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    for (let i = 0; i < days; i++) {
      const day = dayString(new Date(start + i * 86_400_000));
      const next = dayString(new Date(start + (i + 1) * 86_400_000));
      const name = partitionName(day);
      if (existing.has(name)) continue;
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events FOR VALUES FROM ('${day}') TO ('${next}')`,
      );
      created.push(name);
    }
    return created;
  }

  async dropPartitionsBefore(before: Date): Promise<string[]> {
    const cutoff = dayString(before);
    const dropped: string[] = [];
    for (const name of await this.listPartitions()) {
      const m = /^events_(\d{4})(\d{2})(\d{2})$/.exec(name);
      if (!m) continue;
      // a partition covers [day, day+1); drop when its end is on or before the cutoff day
      const end = dayString(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)));
      if (end <= cutoff) {
        await this.db.query(`DROP TABLE IF EXISTS ${name}`);
        dropped.push(name);
      }
    }
    return dropped;
  }

  async listPartitions(): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT c.relname AS name FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'events' ORDER BY c.relname`,
    );
    return rows.map((r: Row) => r.name as string);
  }
}

// ------------------------------------------------------------------ rollups

const UPSERT_COLUMNS = [...KEY_COLUMNS, 'minute', ...COUNTER_COLUMNS, 'latency_sum_ms'];

function rollupWhere(tenant: Tenant, q: RollupQuery, params: unknown[]): string {
  params.push(tenant.orgId, tenant.projectId, q.from, q.to);
  const parts = ['org_id = $1', 'project_id = $2', 'minute >= $3', 'minute < $4'];
  for (const k of ['environment', 'provider', 'endpoint', 'method'] as const) {
    if (q[k] !== undefined) {
      params.push(q[k]);
      parts.push(`${k} = $${params.length}`);
    }
  }
  return parts.join(' AND ');
}

class PgRollupStore implements RollupStore {
  constructor(private readonly db: Queryable) {}

  async upsert(tenant: Tenant, deltas: RollupDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    const arrays: unknown[][] = UPSERT_COLUMNS.map(() => []);
    // sort keys so concurrent batches touching the same rows lock them in the same order
    const sorted = [...deltas].sort((a, b) =>
      `${a.environment}\u0000${a.provider}\u0000${a.endpoint}\u0000${a.method}\u0000${a.minute}`.localeCompare(
        `${b.environment}\u0000${b.provider}\u0000${b.endpoint}\u0000${b.method}\u0000${b.minute}`,
      ),
    );
    for (const d of sorted) {
      const values: unknown[] = [
        d.environment,
        d.provider,
        d.endpoint,
        d.method,
        d.minute,
        d.total,
        ...Object.values(pickOutcomes(d)),
        d.status429,
        ...d.latencyHistogram,
        ...STATUS_COLUMNS.map(([k]) => d.statusCounts?.[k] ?? 0),
        d.latencySumMs,
      ];
      values.forEach((v, i) => arrays[i]!.push(v));
    }
    const types = UPSERT_COLUMNS.map((c) =>
      KEY_COLUMNS.includes(c as (typeof KEY_COLUMNS)[number])
        ? 'text[]'
        : c === 'minute'
          ? 'timestamptz[]'
          : c === 'latency_sum_ms'
            ? 'float8[]'
            : 'int[]',
    );
    const unnest = types.map((t, i) => `$${i + 3}::${t}`).join(', ');
    const updates = [...COUNTER_COLUMNS, 'latency_sum_ms']
      .map((c) => `${c} = rollups_1m.${c} + EXCLUDED.${c}`)
      .join(', ');
    await this.db.query(
      `INSERT INTO rollups_1m (org_id, project_id, ${UPSERT_COLUMNS.join(', ')})
       SELECT $1, $2, u.* FROM unnest(${unnest}) AS u
       ON CONFLICT (org_id, project_id, environment, provider, endpoint, method, minute)
       DO UPDATE SET ${updates}`,
      [tenant.orgId, tenant.projectId, ...arrays],
    );
  }

  async query(tenant: Tenant, q: RollupQuery) {
    const params: unknown[] = [];
    const { rows } = await this.db.query(
      `SELECT * FROM rollups_1m WHERE ${rollupWhere(tenant, q, params)} ORDER BY minute`,
      params,
    );
    return rows.map(rowToRollup);
  }

  async aggregateByKey(tenant: Tenant, q: RollupQuery) {
    const params: unknown[] = [];
    const { rows } = await this.db.query(
      `SELECT org_id, project_id, environment, provider, endpoint, method, min(minute) AS minute,
              max(minute) AS last_minute, count(*)::int AS minutes, ${SUM_SELECT}
         FROM rollups_1m WHERE ${rollupWhere(tenant, q, params)}
        GROUP BY org_id, project_id, environment, provider, endpoint, method`,
      params,
    );
    return rows.map((r: Row) => ({
      ...rowToRollup(r),
      minutes: Number(r.minutes),
      firstMinute: (r.minute as Date).toISOString(),
      lastMinute: (r.last_minute as Date).toISOString(),
    }));
  }

  async series(tenant: Tenant, q: RollupQuery & { bucketMinutes: number }) {
    const params: unknown[] = [];
    const where = rollupWhere(tenant, q, params);
    params.push(q.bucketMinutes * 60);
    const b = `$${params.length}`;
    const { rows } = await this.db.query(
      `SELECT to_timestamp(floor(extract(epoch FROM minute) / ${b}) * ${b}) AS minute, ${SUM_SELECT}
         FROM rollups_1m WHERE ${where}
        GROUP BY 1 ORDER BY 1`,
      params,
    );
    return rows.map(rowToRollup);
  }

  async moveProvider(tenant: Tenant, from: string, to: string) {
    const cols = [...COUNTER_COLUMNS, 'latency_sum_ms'];
    const { rowCount } = await this.db.query(
      `WITH moved AS (
         DELETE FROM rollups_1m WHERE org_id = $1 AND project_id = $2 AND provider = $3 RETURNING *
       )
       INSERT INTO rollups_1m (org_id, project_id, environment, provider, endpoint, method, minute, ${cols.join(', ')})
       SELECT org_id, project_id, environment, $4, endpoint, method, minute, ${cols.join(', ')} FROM moved
       ORDER BY environment, endpoint, method, minute
       ON CONFLICT (org_id, project_id, environment, provider, endpoint, method, minute) DO UPDATE SET
         ${cols.map((c) => `${c} = rollups_1m.${c} + EXCLUDED.${c}`).join(', ')}`,
      [tenant.orgId, tenant.projectId, from, to],
    );
    return rowCount ?? 0;
  }

  async listKeys(tenant: Tenant, q: { provider?: string; since?: Date }) {
    const params: unknown[] = [tenant.orgId, tenant.projectId];
    let where = 'org_id = $1 AND project_id = $2';
    if (q.provider !== undefined) {
      params.push(q.provider);
      where += ` AND provider = $${params.length}`;
    }
    if (q.since) {
      params.push(q.since);
      where += ` AND minute >= $${params.length}`;
    }
    const { rows } = await this.db.query(
      `SELECT DISTINCT environment, provider, endpoint, method FROM rollups_1m WHERE ${where}`,
      params,
    );
    return rows.map((r: Row) => ({
      environment: r.environment as string,
      provider: r.provider as string,
      endpoint: r.endpoint as string,
      method: r.method as string,
    }));
  }

  async moveEndpoint(tenant: Tenant, m: EndpointMove) {
    const cols = [...COUNTER_COLUMNS, 'latency_sum_ms'];
    const { rowCount } = await this.db.query(
      `WITH moved AS (
         DELETE FROM rollups_1m
          WHERE org_id = $1 AND project_id = $2 AND provider = $3 AND method = $4 AND endpoint = $5
         RETURNING *
       )
       INSERT INTO rollups_1m (org_id, project_id, environment, provider, endpoint, method, minute, ${cols.join(', ')})
       SELECT org_id, project_id, environment, provider, $6, method, minute, ${cols.join(', ')} FROM moved
       ORDER BY environment, minute
       ON CONFLICT (org_id, project_id, environment, provider, endpoint, method, minute) DO UPDATE SET
         ${cols.map((c) => `${c} = rollups_1m.${c} + EXCLUDED.${c}`).join(', ')}`,
      [tenant.orgId, tenant.projectId, m.provider, m.method, m.from, m.to],
    );
    return rowCount ?? 0;
  }

  async activeKeys(from: Date) {
    const { rows } = await this.db.query(
      `SELECT DISTINCT org_id, project_id, environment, provider, endpoint, method
         FROM rollups_1m WHERE minute >= $1`,
      [from],
    );
    return rows.map((r: Row) => ({
      orgId: r.org_id as string,
      projectId: r.project_id as string,
      environment: r.environment as string,
      provider: r.provider as string,
      endpoint: r.endpoint as string,
      method: r.method as string,
    }));
  }

  async deleteBefore(before: Date, tenant?: Tenant): Promise<number> {
    const res = tenant
      ? await this.db.query(
          `DELETE FROM rollups_1m WHERE org_id = $1 AND project_id = $2 AND minute < $3`,
          [tenant.orgId, tenant.projectId, before],
        )
      : await this.db.query(`DELETE FROM rollups_1m WHERE minute < $1`, [before]);
    return res.rowCount ?? 0;
  }
}

function pickOutcomes(d: RollupDelta): Record<string, number> {
  // same order as OUTCOME_COLUMNS inside COUNTER_COLUMNS
  return {
    ok: d.outcomes.ok,
    http_4xx: d.outcomes.http_4xx,
    http_5xx: d.outcomes.http_5xx,
    timeout: d.outcomes.timeout,
    conn_reset: d.outcomes.conn_reset,
    conn_refused: d.outcomes.conn_refused,
    dns: d.outcomes.dns,
    tls: d.outcomes.tls,
    aborted: d.outcomes.aborted,
    other_error: d.outcomes.other_error,
  };
}

// ------------------------------------------------------------------ incidents

function rowToBaseline(r: Row): Baseline {
  return {
    environment: r.environment as string,
    provider: r.provider as string,
    endpoint: r.endpoint as string,
    method: r.method as string,
    providerErrorRate: Number(r.provider_error_rate),
    rate4xx: Number(r.rate_4xx),
    rate429: Number(r.rate_429),
    p50Ms: r.p50_ms === null ? null : Number(r.p50_ms),
    p95Ms: r.p95_ms === null ? null : Number(r.p95_ms),
    ...(() => {
      const { learning, ...mix } = (r.status_mix as Record<string, number> | null) ?? {};
      return { statusMix: mix as Baseline['statusMix'], statusMixLearning: Boolean(learning) };
    })(),
    callsPerMin:
      Number(r.history_minutes) > 0 ? Number(r.sample_size) / Number(r.history_minutes) : null,
    sampleSize: Number(r.sample_size),
    historyMinutes: Number(r.history_minutes),
    learning: Boolean(r.learning),
    computedAt: r.computed_at as Date,
  };
}

class PgIncidentStore implements IncidentStore {
  constructor(private readonly db: Queryable) {}

  async moveProvider(tenant: Tenant, from: string, to: string) {
    await this.db.query(
      `UPDATE incidents SET provider = $4 WHERE org_id = $1 AND project_id = $2 AND provider = $3`,
      [tenant.orgId, tenant.projectId, from, to],
    );
    // both providers' baselines are recomputed from the merged rollups on the next tick
    await this.db.query(
      `DELETE FROM baselines WHERE org_id = $1 AND project_id = $2 AND provider IN ($3, $4)`,
      [tenant.orgId, tenant.projectId, from, to],
    );
  }

  async moveEndpoint(tenant: Tenant, m: EndpointMove) {
    const p = [tenant.orgId, tenant.projectId, m.provider, m.method, m.from, m.to];
    const ofProvider = `incident_id IN (SELECT id FROM incidents WHERE org_id = $1 AND project_id = $2 AND provider = $3)`;
    // an incident with both: one row for `to`, from the earliest sighting, the worst peak,
    // recovered only when both had recovered
    await this.db.query(
      `UPDATE incident_endpoints t SET
         first_seen_at = LEAST(t.first_seen_at, f.first_seen_at),
         peak_error_rate = GREATEST(t.peak_error_rate, f.peak_error_rate),
         recovered_at = CASE WHEN t.recovered_at IS NULL OR f.recovered_at IS NULL THEN NULL
                             ELSE GREATEST(t.recovered_at, f.recovered_at) END
         FROM incident_endpoints f
        WHERE f.incident_id = t.incident_id AND f.method = $4 AND f.endpoint = $5
          AND t.method = $4 AND t.endpoint = $6 AND t.${ofProvider}`,
      p,
    );
    await this.db.query(
      `DELETE FROM incident_endpoints f
        WHERE f.method = $4 AND f.endpoint = $5 AND f.${ofProvider}
          AND EXISTS (SELECT 1 FROM incident_endpoints t
                       WHERE t.incident_id = f.incident_id AND t.method = $4 AND t.endpoint = $6)`,
      p,
    );
    await this.db.query(
      `UPDATE incident_endpoints SET endpoint = $6
        WHERE method = $4 AND endpoint = $5 AND ${ofProvider}`,
      p,
    );
    // one endpoint left: no longer a provider-wide incident
    await this.db.query(
      `UPDATE incidents i SET scope = 'endpoint', updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND provider = $3 AND scope = 'provider'
          AND (SELECT count(*) FROM incident_endpoints e WHERE e.incident_id = i.id) = 1`,
      p.slice(0, 3),
    );
    await this.db.query(
      `DELETE FROM baselines WHERE org_id = $1 AND project_id = $2 AND provider = $3
          AND method = $4 AND endpoint IN ($5, $6)`,
      p,
    );
  }

  async getBaselines(tenant: Tenant): Promise<Baseline[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM baselines WHERE org_id = $1 AND project_id = $2`,
      [tenant.orgId, tenant.projectId],
    );
    return rows.map(rowToBaseline);
  }

  async upsertBaselines(tenant: Tenant, baselines: Baseline[]): Promise<void> {
    for (const b of baselines) {
      await this.db.query(
        `INSERT INTO baselines (org_id, project_id, environment, provider, endpoint, method, provider_error_rate,
                                rate_4xx, rate_429, p50_ms, p95_ms, sample_size, history_minutes, learning, computed_at,
                                status_mix)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (org_id, project_id, environment, provider, endpoint, method) DO UPDATE SET
           provider_error_rate = EXCLUDED.provider_error_rate, rate_4xx = EXCLUDED.rate_4xx,
           rate_429 = EXCLUDED.rate_429, p50_ms = EXCLUDED.p50_ms, p95_ms = EXCLUDED.p95_ms,
           sample_size = EXCLUDED.sample_size, history_minutes = EXCLUDED.history_minutes,
           status_mix = EXCLUDED.status_mix,
           learning = EXCLUDED.learning, computed_at = EXCLUDED.computed_at`,
        [
          tenant.orgId,
          tenant.projectId,
          b.environment,
          b.provider,
          b.endpoint,
          b.method,
          b.providerErrorRate,
          b.rate4xx,
          b.rate429,
          b.p50Ms,
          b.p95Ms,
          b.sampleSize,
          b.historyMinutes,
          b.learning,
          b.computedAt,
          JSON.stringify({
            ...(b.statusMix ?? {}),
            ...(b.statusMixLearning ? { learning: 1 } : {}),
          }),
        ],
      );
    }
  }

  async incidentWindows(tenant: Tenant, key: RollupKey, since: Date) {
    const { rows } = await this.db.query(
      `SELECT e.first_seen_at AS from_ts, coalesce(e.recovered_at, i.resolved_at) AS to_ts
         FROM incident_endpoints e JOIN incidents i ON i.id = e.incident_id
        WHERE e.org_id = $1 AND e.project_id = $2 AND i.environment = $3 AND i.provider = $4
          AND e.endpoint = $5 AND e.method = $6
          AND (coalesce(e.recovered_at, i.resolved_at) IS NULL OR coalesce(e.recovered_at, i.resolved_at) >= $7)`,
      [
        tenant.orgId,
        tenant.projectId,
        key.environment,
        key.provider,
        key.endpoint,
        key.method,
        since,
      ],
    );
    return rows.map((r: Row) => ({
      from: r.from_ts as Date,
      to: (r.to_ts as Date | null) ?? null,
    }));
  }

  private async hydrate(rows: Row[]): Promise<Incident[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id as string);
    const { rows: eps } = await this.db.query(
      `SELECT * FROM incident_endpoints WHERE incident_id = ANY($1::text[]) ORDER BY first_seen_at`,
      [ids],
    );
    const byId = new Map<string, Incident['endpoints']>();
    for (const e of eps as Row[]) {
      const list = byId.get(e.incident_id as string) ?? [];
      list.push({
        endpoint: e.endpoint as string,
        method: e.method as string,
        firstSeenAt: e.first_seen_at as Date,
        recoveredAt: (e.recovered_at as Date | null) ?? null,
        peakErrorRate: Number(e.peak_error_rate),
      });
      byId.set(e.incident_id as string, list);
    }
    return rows.map((r) => ({
      id: r.id as string,
      orgId: r.org_id as string,
      projectId: r.project_id as string,
      environment: r.environment as string,
      provider: r.provider as string,
      scope: r.scope as Incident['scope'],
      kind: r.kind as Incident['kind'],
      status: r.status as Incident['status'],
      openedAt: r.opened_at as Date,
      resolvedAt: (r.resolved_at as Date | null) ?? null,
      lastAlertedRate: r.last_alerted_rate === null ? null : Number(r.last_alerted_rate),
      lastAlertedP95Ms: r.last_alerted_p95_ms === null ? null : Number(r.last_alerted_p95_ms),
      lastEvaluatedMinute: (r.last_evaluated_minute as Date | null) ?? null,
      windowMinutes: Number(r.window_minutes ?? 5),
      deployHint: (r.deploy_hint as string | null) ?? null,
      alertsMuted: Boolean(r.alerts_muted),
      peakErrorRate: Number(r.peak_error_rate),
      peakP95Ms: r.peak_p95_ms === null ? null : Number(r.peak_p95_ms),
      baseline: (r.baseline as Record<string, unknown>) ?? {},
      summary: r.summary as string,
      sampleRequestIds: (r.sample_request_ids as string[]) ?? [],
      endpoints: byId.get(r.id as string) ?? [],
    }));
  }

  async list(tenant: Tenant, q: IncidentListQuery): Promise<Incident[]> {
    const params: unknown[] = [tenant.orgId, tenant.projectId];
    const parts = ['org_id = $1', 'project_id = $2'];
    if (q.status) {
      params.push(q.status);
      parts.push(`status = $${params.length}`);
    }
    if (q.provider) {
      params.push(q.provider);
      parts.push(`provider = $${params.length}`);
    }
    if (q.since) {
      params.push(q.since);
      parts.push(`(resolved_at IS NULL OR resolved_at >= $${params.length})`);
    }
    params.push(q.limit ?? 100);
    const { rows } = await this.db.query(
      `SELECT * FROM incidents WHERE ${parts.join(' AND ')} ORDER BY opened_at DESC LIMIT $${params.length}`,
      params,
    );
    return this.hydrate(rows);
  }

  async get(tenant: Tenant, id: string): Promise<Incident | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM incidents WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [tenant.orgId, tenant.projectId, id],
    );
    return (await this.hydrate(rows))[0] ?? null;
  }

  async listOpenAll(): Promise<Incident[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM incidents WHERE status = 'open' ORDER BY opened_at`,
    );
    return this.hydrate(rows);
  }

  async lastResolvedAt(
    tenant: Tenant,
    environment: string,
    provider: string,
    endpoint: string,
    method: string,
  ) {
    const { rows } = await this.db.query(
      `SELECT max(coalesce(e.recovered_at, i.resolved_at)) AS at
         FROM incident_endpoints e JOIN incidents i ON i.id = e.incident_id
        WHERE e.org_id = $1 AND e.project_id = $2 AND i.environment = $3 AND i.provider = $4
          AND e.endpoint = $5 AND e.method = $6`,
      [tenant.orgId, tenant.projectId, environment, provider, endpoint, method],
    );
    return (rows[0]?.at as Date | null) ?? null;
  }

  async create(i: Incident): Promise<void> {
    await this.db.query(
      `INSERT INTO incidents (id, org_id, project_id, environment, provider, scope, kind, status, opened_at,
                              resolved_at, last_alerted_rate, last_alerted_p95_ms, last_evaluated_minute,
                              alerts_muted, peak_error_rate, peak_p95_ms, baseline, summary, sample_request_ids,
                              window_minutes, deploy_hint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        i.id,
        i.orgId,
        i.projectId,
        i.environment,
        i.provider,
        i.scope,
        i.kind,
        i.status,
        i.openedAt,
        i.resolvedAt,
        i.lastAlertedRate,
        i.lastAlertedP95Ms,
        i.lastEvaluatedMinute,
        i.alertsMuted,
        i.peakErrorRate,
        i.peakP95Ms,
        JSON.stringify(i.baseline),
        i.summary,
        i.sampleRequestIds,
        i.windowMinutes ?? 5,
        i.deployHint ?? null,
      ],
    );
    await this.writeEndpoints(i);
  }

  async update(i: Incident): Promise<void> {
    await this.db.query(
      `UPDATE incidents SET scope = $3, kind = $4, status = $5, resolved_at = $6, last_alerted_rate = $7,
              last_alerted_p95_ms = $8, last_evaluated_minute = $9, alerts_muted = $10, peak_error_rate = $11,
              peak_p95_ms = $12, baseline = $13, summary = $14, sample_request_ids = $15,
              window_minutes = $16, deploy_hint = $17, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [
        i.id,
        i.orgId,
        i.scope,
        i.kind,
        i.status,
        i.resolvedAt,
        i.lastAlertedRate,
        i.lastAlertedP95Ms,
        i.lastEvaluatedMinute,
        i.alertsMuted,
        i.peakErrorRate,
        i.peakP95Ms,
        JSON.stringify(i.baseline),
        i.summary,
        i.sampleRequestIds,
        i.windowMinutes ?? 5,
        i.deployHint ?? null,
      ],
    );
    await this.writeEndpoints(i);
  }

  private async writeEndpoints(i: Incident): Promise<void> {
    for (const e of i.endpoints) {
      await this.db.query(
        `INSERT INTO incident_endpoints (incident_id, org_id, project_id, endpoint, method, first_seen_at,
                                         recovered_at, peak_error_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (incident_id, endpoint, method) DO UPDATE SET
           recovered_at = EXCLUDED.recovered_at, peak_error_rate = EXCLUDED.peak_error_rate`,
        [
          i.id,
          i.orgId,
          i.projectId,
          e.endpoint,
          e.method,
          e.firstSeenAt,
          e.recoveredAt,
          e.peakErrorRate,
        ],
      );
    }
  }
}

// ------------------------------------------------------------------ config

function rowToApiKey(r: Row): ApiKeyRecord {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    keyPrefix: r.key_prefix as string,
    scopes: r.scopes as ApiKeyRecord['scopes'],
    createdAt: r.created_at as Date,
    lastUsedAt: (r.last_used_at as Date | null) ?? null,
    revokedAt: (r.revoked_at as Date | null) ?? null,
  };
}

function rowToProvider(r: Row): ProviderRecord {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    hostPatterns: (r.host_patterns as string[]) ?? [],
    explicitRoutes: (r.explicit_routes as string[]) ?? [],
    supportEmail: (r.support_email as string | null) ?? null,
    supportUrl: (r.support_url as string | null) ?? null,
    supportNotes: (r.support_notes as string | null) ?? null,
    publicDisplayName: (r.public_display_name as string | null) ?? null,
    isPublic: Boolean(r.is_public),
    source: ((r.source as string | undefined) ?? 'configured') as ProviderRecord['source'],
    category: (r.category as string | null) ?? null,
    hosts: (r.hosts as string[] | undefined) ?? [],
    domain: (r.domain as string | null) ?? null,
    hidden: Boolean(r.hidden),
    internal: Boolean(r.internal),
    alertsEnabled: r.alerts_enabled === undefined ? true : Boolean(r.alerts_enabled),
    firstSeenAt: new Date((r.first_seen_at ?? r.created_at) as string),
    lastCallAt: r.last_call_at ? new Date(r.last_call_at as string) : null,
    displayName: (r.display_name as string | null) ?? null,
    pathPrivacy: (r.path_privacy as ProviderRecord['pathPrivacy'] | undefined) ?? null,
    allowedPathWords: (r.allowed_path_words as string[] | undefined) ?? [],
    endpointAliases: (r.endpoint_aliases as Record<string, string> | undefined) ?? {},
    thresholds: (r.thresholds as Record<string, number> | undefined) ?? {},
  };
}

function rowToChannel(r: Row): AlertChannelRecord {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    kind: r.kind as AlertChannelRecord['kind'],
    name: r.name as string,
    config: (r.config as Record<string, unknown>) ?? {},
    enabled: Boolean(r.enabled),
  };
}

function rowToDelivery(r: Row): AlertDelivery {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    channelId: r.channel_id as string,
    incidentId: (r.incident_id as string | null) ?? null,
    event: r.event as AlertDelivery['event'],
    status: r.status as AlertDelivery['status'],
    attempts: Number(r.attempts),
    nextAttemptAt: r.next_attempt_at as Date,
    lastError: (r.last_error as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: r.created_at as Date,
    sentAt: (r.sent_at as Date | null) ?? null,
  };
}

function rowToStatusPage(r: Row): StatusPageRecord {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    publicToken: r.public_token as string,
    title: r.title as string,
    providerFilter: (r.provider_filter as string[]) ?? [],
    theme: r.theme as StatusPageRecord['theme'],
  };
}

const PROVIDER_FIELDS: [keyof ProviderInput, string][] = [
  ['name', 'name'],
  ['hostPatterns', 'host_patterns'],
  ['explicitRoutes', 'explicit_routes'],
  ['supportEmail', 'support_email'],
  ['supportUrl', 'support_url'],
  ['supportNotes', 'support_notes'],
  ['publicDisplayName', 'public_display_name'],
  ['isPublic', 'is_public'],
  ['source', 'source'],
  ['category', 'category'],
  ['hosts', 'hosts'],
  ['domain', 'domain'],
  ['hidden', 'hidden'],
  ['internal', 'internal'],
  ['alertsEnabled', 'alerts_enabled'],
  ['displayName', 'display_name'],
  ['pathPrivacy', 'path_privacy'],
  ['allowedPathWords', 'allowed_path_words'],
  ['endpointAliases', 'endpoint_aliases'],
  ['thresholds', 'thresholds'],
];

class PgConfigStore implements ConfigStore {
  constructor(private readonly db: Queryable) {}

  async createOrg(id: string, name: string) {
    await this.db.query(`INSERT INTO orgs (id, name) VALUES ($1, $2)`, [id, name]);
  }
  async listOrgs() {
    const { rows } = await this.db.query(`SELECT id, name FROM orgs ORDER BY created_at`);
    return rows as { id: string; name: string }[];
  }
  async createUser(id: string, name: string, email: string | null) {
    await this.db.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      name,
      email,
    ]);
  }
  async addMembership(m: MembershipRecord) {
    await this.db.query(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [m.orgId, m.userId, m.role],
    );
  }
  async membershipsForUser(userId: string) {
    const { rows } = await this.db.query(
      `SELECT org_id, user_id, role FROM memberships WHERE user_id = $1`,
      [userId],
    );
    return rows.map((r: Row) => ({
      orgId: r.org_id as string,
      userId: r.user_id as string,
      role: r.role as MembershipRecord['role'],
    }));
  }
  async createProject(orgId: string, id: string, name: string) {
    await this.db.query(`INSERT INTO projects (id, org_id, name) VALUES ($1, $2, $3)`, [
      id,
      orgId,
      name,
    ]);
  }
  async listProjects(orgId: string) {
    const { rows } = await this.db.query(
      `SELECT id, name FROM projects WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    return rows as { id: string; name: string }[];
  }
  async countProjects(orgId: string) {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM projects WHERE org_id = $1`,
      [orgId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async createApiKey(
    rec: Omit<ApiKeyRecord, 'createdAt' | 'lastUsedAt' | 'revokedAt'>,
    keyHash: string,
  ) {
    await this.db.query(
      `INSERT INTO api_keys (id, org_id, project_id, name, key_hash, key_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [rec.id, rec.orgId, rec.projectId, rec.name, keyHash, rec.keyPrefix, rec.scopes],
    );
  }
  async findApiKeyByHash(keyHash: string) {
    const { rows } = await this.db.query(`SELECT * FROM api_keys WHERE key_hash = $1`, [keyHash]);
    return rows[0] ? rowToApiKey(rows[0]) : null;
  }
  async listApiKeys(t: Tenant) {
    const { rows } = await this.db.query(
      `SELECT * FROM api_keys WHERE org_id = $1 AND project_id = $2 ORDER BY created_at`,
      [t.orgId, t.projectId],
    );
    return rows.map(rowToApiKey);
  }
  async revokeApiKey(t: Tenant, id: string) {
    const res = await this.db.query(
      `UPDATE api_keys SET revoked_at = now() WHERE org_id = $1 AND project_id = $2 AND id = $3 AND revoked_at IS NULL`,
      [t.orgId, t.projectId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }
  async touchApiKey(id: string, at: Date) {
    await this.db.query(`UPDATE api_keys SET last_used_at = $2 WHERE id = $1`, [id, at]);
  }

  async listProviders(t: Tenant) {
    const { rows } = await this.db.query(
      `SELECT * FROM providers WHERE org_id = $1 AND project_id = $2 ORDER BY name`,
      [t.orgId, t.projectId],
    );
    return rows.map(rowToProvider);
  }
  async upsertProvider(t: Tenant, input: ProviderInput) {
    // discovery fields: set on insert (defaults when absent); on update only when given
    const { rows } = await this.db.query(
      `INSERT INTO providers (id, org_id, project_id, name, host_patterns, explicit_routes, support_email,
                              support_url, support_notes, public_display_name, is_public,
                              source, category, hosts, domain, alerts_enabled, display_name,
                              first_seen_at, digest_notified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               COALESCE($12, 'configured'), $13, COALESCE($14, '{}'::text[]), $15, COALESCE($16, true), $17,
               COALESCE($18, now()), $18)
       ON CONFLICT (project_id, name) DO UPDATE SET
         host_patterns = EXCLUDED.host_patterns, explicit_routes = EXCLUDED.explicit_routes,
         support_email = EXCLUDED.support_email, support_url = EXCLUDED.support_url,
         support_notes = EXCLUDED.support_notes, public_display_name = EXCLUDED.public_display_name,
         is_public = EXCLUDED.is_public,
         source = COALESCE($12, providers.source), category = COALESCE($13, providers.category),
         hosts = COALESCE($14, providers.hosts), domain = COALESCE($15, providers.domain),
         alerts_enabled = COALESCE($16, providers.alerts_enabled),
         display_name = COALESCE($17, providers.display_name),
         first_seen_at = LEAST(providers.first_seen_at, COALESCE($18, providers.first_seen_at)),
         digest_notified_at = COALESCE(providers.digest_notified_at, $18), updated_at = now()
       RETURNING *`,
      [
        newId('prv'),
        t.orgId,
        t.projectId,
        input.name,
        input.hostPatterns,
        input.explicitRoutes,
        input.supportEmail,
        input.supportUrl,
        input.supportNotes,
        input.publicDisplayName,
        input.isPublic,
        input.source ?? null,
        input.category ?? null,
        input.hosts ?? null,
        input.domain ?? null,
        input.alertsEnabled ?? null,
        input.displayName ?? null,
        // a known first-seen time (import, demo history) also counts as already announced
        input.firstSeenAt ?? null,
      ],
    );
    return rowToProvider(rows[0]);
  }
  async updateProvider(t: Tenant, id: string, input: Partial<ProviderInput>) {
    const sets: string[] = [];
    const params: unknown[] = [t.orgId, t.projectId, id];
    for (const [k, col] of PROVIDER_FIELDS) {
      if (input[k] !== undefined) {
        params.push(input[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length === 0) {
      const { rows } = await this.db.query(
        `SELECT * FROM providers WHERE org_id = $1 AND project_id = $2 AND id = $3`,
        params,
      );
      return rows[0] ? rowToProvider(rows[0]) : null;
    }
    const { rows } = await this.db.query(
      `UPDATE providers SET ${sets.join(', ')}, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3 RETURNING *`,
      params,
    );
    return rows[0] ? rowToProvider(rows[0]) : null;
  }
  async deleteProvider(t: Tenant, id: string) {
    const res = await this.db.query(
      `DELETE FROM providers WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [t.orgId, t.projectId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }
  async recordDiscoveredHost(t: Tenant, d: DiscoveredHost, maxHosts: number) {
    const { rows } = await this.db.query(
      `INSERT INTO providers (id, org_id, project_id, name, source, category, domain, hosts, alerts_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY[$8::text], $9)
       ON CONFLICT (project_id, name) DO UPDATE SET
         hosts = CASE WHEN $8 = ANY(providers.hosts) OR cardinality(providers.hosts) >= $10
                      THEN providers.hosts ELSE array_append(providers.hosts, $8) END,
         domain = COALESCE(providers.domain, EXCLUDED.domain),
         category = COALESCE(providers.category, EXCLUDED.category)
       RETURNING *`,
      [
        newId('prv'),
        t.orgId,
        t.projectId,
        d.name,
        d.source,
        d.category,
        d.domain,
        d.host,
        d.alertsEnabled,
        maxHosts,
      ],
    );
    return rowToProvider(rows[0]);
  }
  async countProviders(t: Tenant) {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM providers WHERE org_id = $1 AND project_id = $2`,
      [t.orgId, t.projectId],
    );
    return rows[0].n as number;
  }
  async absorbProvider(t: Tenant, fromId: string, intoId: string) {
    const { rows } = await this.db.query(
      `WITH src AS (
         DELETE FROM providers WHERE org_id = $1 AND project_id = $2 AND id = $3 RETURNING *
       )
       UPDATE providers p SET
         hosts = ARRAY(SELECT DISTINCT unnest(p.hosts || src.hosts)),
         host_patterns = ARRAY(SELECT DISTINCT unnest(p.host_patterns || src.host_patterns)),
         explicit_routes = ARRAY(SELECT DISTINCT unnest(p.explicit_routes || src.explicit_routes)),
         allowed_path_words = ARRAY(SELECT DISTINCT unnest(p.allowed_path_words || src.allowed_path_words)),
         -- strict if either was strict: a merge never loosens path privacy
         path_privacy = CASE WHEN 'strict' IN (p.path_privacy, src.path_privacy) THEN 'strict'
                             ELSE COALESCE(p.path_privacy, src.path_privacy) END,
         first_seen_at = LEAST(p.first_seen_at, src.first_seen_at),
         last_call_at = GREATEST(p.last_call_at, src.last_call_at),
         endpoint_aliases = src.endpoint_aliases || p.endpoint_aliases,
         updated_at = now()
       FROM src
       WHERE p.org_id = $1 AND p.project_id = $2 AND p.id = $4
       RETURNING p.*`,
      [t.orgId, t.projectId, fromId, intoId],
    );
    return rows[0] ? rowToProvider(rows[0]) : null;
  }
  async getDiscoveryDigest(t: Tenant) {
    const { rows } = await this.db.query(
      `SELECT discovery_digest FROM settings WHERE org_id = $1 AND project_id = $2`,
      [t.orgId, t.projectId],
    );
    return rows[0] ? Boolean(rows[0].discovery_digest) : true;
  }
  async setDiscoveryDigest(t: Tenant, enabled: boolean) {
    await this.db.query(
      `INSERT INTO settings (org_id, project_id, discovery_digest) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, project_id) DO UPDATE SET discovery_digest = $3, updated_at = now()`,
      [t.orgId, t.projectId, enabled],
    );
  }
  async takeUndigestedProviders(t: Tenant) {
    const { rows } = await this.db.query(
      `UPDATE providers SET digest_notified_at = now()
        WHERE org_id = $1 AND project_id = $2 AND digest_notified_at IS NULL
          AND source <> 'configured' AND NOT hidden AND NOT internal
        RETURNING *`,
      [t.orgId, t.projectId],
    );
    return rows.map(rowToProvider).sort((a, b) => a.name.localeCompare(b.name));
  }
  async ensureProviders(t: Tenant, names: string[], hosts: Map<string, string>) {
    if (names.length === 0) return;
    await this.db.query(
      `INSERT INTO providers (id, org_id, project_id, name, host_patterns)
       SELECT 'prv_' || substr(md5(random()::text || n), 1, 16), $1, $2, n, ARRAY[h]
         FROM unnest($3::text[], $4::text[]) AS u(n, h)
       ON CONFLICT (project_id, name) DO NOTHING`,
      [t.orgId, t.projectId, names, names.map((n) => hosts.get(n) ?? '')],
    );
  }

  async touchProviders(t: Tenant, lastCalls: Map<string, Date>) {
    if (lastCalls.size === 0) return;
    // a row is written at most every 30 s per provider: concurrent batches rarely
    // contend for it, and "last call" needs no more precision than that
    await this.db.query(
      `UPDATE providers p SET last_call_at = u.at
         FROM unnest($3::text[], $4::timestamptz[]) AS u(name, at)
        WHERE p.org_id = $1 AND p.project_id = $2 AND p.name = u.name
          AND (p.last_call_at IS NULL OR p.last_call_at < u.at - interval '30 seconds')`,
      [t.orgId, t.projectId, [...lastCalls.keys()], [...lastCalls.values()]],
    );
  }

  async listAlertChannels(t: Tenant) {
    const { rows } = await this.db.query(
      `SELECT * FROM alert_channels WHERE org_id = $1 AND project_id = $2 ORDER BY created_at`,
      [t.orgId, t.projectId],
    );
    return rows.map(rowToChannel);
  }
  async getAlertChannel(t: Tenant, id: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM alert_channels WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [t.orgId, t.projectId, id],
    );
    return rows[0] ? rowToChannel(rows[0]) : null;
  }
  async createAlertChannel(t: Tenant, input: AlertChannelInput) {
    const { rows } = await this.db.query(
      `INSERT INTO alert_channels (id, org_id, project_id, kind, name, config, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        newId('chn'),
        t.orgId,
        t.projectId,
        input.kind,
        input.name,
        JSON.stringify(input.config),
        input.enabled,
      ],
    );
    return rowToChannel(rows[0]);
  }
  async updateAlertChannel(t: Tenant, id: string, input: Partial<AlertChannelInput>) {
    const current = await this.getAlertChannel(t, id);
    if (!current) return null;
    const next = { ...current, ...input };
    const { rows } = await this.db.query(
      `UPDATE alert_channels SET kind = $4, name = $5, config = $6, enabled = $7, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3 RETURNING *`,
      [t.orgId, t.projectId, id, next.kind, next.name, JSON.stringify(next.config), next.enabled],
    );
    return rows[0] ? rowToChannel(rows[0]) : null;
  }
  async deleteAlertChannel(t: Tenant, id: string) {
    const res = await this.db.query(
      `DELETE FROM alert_channels WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [t.orgId, t.projectId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }
  async createDelivery(d: AlertDelivery) {
    await this.db.query(
      `INSERT INTO alert_deliveries (id, org_id, project_id, channel_id, incident_id, event, status, attempts,
                                     next_attempt_at, last_error, payload, created_at, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        d.id,
        d.orgId,
        d.projectId,
        d.channelId,
        d.incidentId,
        d.event,
        d.status,
        d.attempts,
        d.nextAttemptAt,
        d.lastError,
        JSON.stringify(d.payload),
        d.createdAt,
        d.sentAt,
      ],
    );
  }
  async updateDelivery(d: AlertDelivery) {
    await this.db.query(
      `UPDATE alert_deliveries SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, sent_at = $6
        WHERE id = $1`,
      [d.id, d.status, d.attempts, d.nextAttemptAt, d.lastError, d.sentAt],
    );
  }
  async dueDeliveries(now: Date, limit: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM alert_deliveries WHERE status = 'pending' AND next_attempt_at <= $1
        ORDER BY next_attempt_at LIMIT $2`,
      [now, limit],
    );
    return rows.map(rowToDelivery);
  }
  async listDeliveries(t: Tenant, limit: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM alert_deliveries WHERE org_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [t.orgId, t.projectId, limit],
    );
    return rows.map(rowToDelivery);
  }

  async listStatusPages(t: Tenant) {
    const { rows } = await this.db.query(
      `SELECT * FROM status_pages WHERE org_id = $1 AND project_id = $2 ORDER BY created_at`,
      [t.orgId, t.projectId],
    );
    return rows.map(rowToStatusPage);
  }
  async countStatusPages(orgId: string) {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM status_pages WHERE org_id = $1`,
      [orgId],
    );
    return rows[0].n as number;
  }
  async createStatusPage(t: Tenant, rec: Omit<StatusPageRecord, 'id' | 'orgId' | 'projectId'>) {
    const { rows } = await this.db.query(
      `INSERT INTO status_pages (id, org_id, project_id, public_token, title, provider_filter, theme)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        newId('stp'),
        t.orgId,
        t.projectId,
        rec.publicToken,
        rec.title,
        rec.providerFilter,
        rec.theme,
      ],
    );
    return rowToStatusPage(rows[0]);
  }
  async updateStatusPage(
    t: Tenant,
    id: string,
    patch: Partial<Pick<StatusPageRecord, 'title' | 'providerFilter' | 'theme'>>,
  ) {
    const { rows } = await this.db.query(
      `UPDATE status_pages SET
         title = COALESCE($4, title),
         provider_filter = COALESCE($5, provider_filter),
         theme = COALESCE($6, theme)
       WHERE org_id = $1 AND project_id = $2 AND id = $3 RETURNING *`,
      [
        t.orgId,
        t.projectId,
        id,
        patch.title ?? null,
        patch.providerFilter ?? null,
        patch.theme ?? null,
      ],
    );
    return rows[0] ? rowToStatusPage(rows[0]) : null;
  }
  async deleteStatusPage(t: Tenant, id: string) {
    const { rowCount } = await this.db.query(
      `DELETE FROM status_pages WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [t.orgId, t.projectId, id],
    );
    return (rowCount ?? 0) > 0;
  }
  async findStatusPageByToken(token: string) {
    const { rows } = await this.db.query(`SELECT * FROM status_pages WHERE public_token = $1`, [
      token,
    ]);
    return rows[0] ? rowToStatusPage(rows[0]) : null;
  }

  async getThresholds(t: Tenant) {
    const { rows } = await this.db.query(
      `SELECT thresholds FROM settings WHERE org_id = $1 AND project_id = $2`,
      [t.orgId, t.projectId],
    );
    return (rows[0]?.thresholds as Record<string, unknown>) ?? {};
  }
  async setThresholds(t: Tenant, thresholds: Record<string, unknown>) {
    await this.db.query(
      `INSERT INTO settings (org_id, project_id, thresholds) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, project_id) DO UPDATE SET thresholds = EXCLUDED.thresholds, updated_at = now()`,
      [t.orgId, t.projectId, JSON.stringify(thresholds)],
    );
  }

  async recordSdkHeartbeat(t: Tenant, hb: SdkHeartbeat, at: Date) {
    const eventAt = hb.hasEvents === false ? null : at;
    await this.db.query(
      `INSERT INTO sdk_instances (org_id, project_id, service, environment, sdk_name, sdk_version, first_seen_at,
                                  last_seen_at, last_event_at, dropped_events, last_flush_error, serverless, platform,
                                  event_batches)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$10,$8,$9,$11,$12, CASE WHEN $10::timestamptz IS NULL THEN 0 ELSE 1 END)
       ON CONFLICT (org_id, project_id, service, environment) DO UPDATE SET
         sdk_name = EXCLUDED.sdk_name, sdk_version = EXCLUDED.sdk_version,
         last_seen_at = GREATEST(sdk_instances.last_seen_at, EXCLUDED.last_seen_at),
         last_event_at = GREATEST(sdk_instances.last_event_at, EXCLUDED.last_event_at),
         -- running average of the gap between batches with calls (weights 0.8 old / 0.2 new)
         event_gap_seconds = CASE
           WHEN EXCLUDED.last_event_at IS NULL OR sdk_instances.last_event_at IS NULL
             THEN sdk_instances.event_gap_seconds
           WHEN sdk_instances.event_gap_seconds IS NULL
             THEN GREATEST(0, EXTRACT(EPOCH FROM EXCLUDED.last_event_at - sdk_instances.last_event_at))
           ELSE 0.8 * sdk_instances.event_gap_seconds
                + 0.2 * GREATEST(0, EXTRACT(EPOCH FROM EXCLUDED.last_event_at - sdk_instances.last_event_at))
         END,
         event_batches = sdk_instances.event_batches + EXCLUDED.event_batches,
         dropped_events = sdk_instances.dropped_events + EXCLUDED.dropped_events,
         last_flush_error = EXCLUDED.last_flush_error,
         -- older SDKs don't say: keep what a newer one reported
         serverless = CASE WHEN $13 THEN EXCLUDED.serverless ELSE sdk_instances.serverless END,
         platform = CASE WHEN $13 THEN EXCLUDED.platform ELSE sdk_instances.platform END`,
      [
        t.orgId,
        t.projectId,
        hb.service,
        hb.environment,
        hb.sdkName,
        hb.sdkVersion,
        at,
        hb.dropped,
        hb.lastFlushError,
        eventAt,
        hb.runtime?.serverless ?? false,
        hb.runtime?.platform ?? null,
        hb.runtime !== undefined,
      ],
    );
    if (!hb.instance) return;
    await this.db.query(
      `INSERT INTO sdk_processes (org_id, project_id, service, environment, instance_id, started_at,
                                  first_seen_at, last_seen_at, last_event_at, sdk_version, runtime,
                                  runtime_version, platform, serverless)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (org_id, project_id, service, environment, instance_id) DO UPDATE SET
         last_seen_at = GREATEST(sdk_processes.last_seen_at, EXCLUDED.last_seen_at),
         last_event_at = GREATEST(sdk_processes.last_event_at, EXCLUDED.last_event_at)`,
      [
        t.orgId,
        t.projectId,
        hb.service,
        hb.environment,
        hb.instance.id,
        hb.instance.startedAt,
        at,
        eventAt,
        hb.sdkVersion,
        hb.runtime?.name ?? null,
        hb.runtime?.version ?? null,
        hb.runtime?.platform ?? null,
        hb.runtime?.serverless ?? false,
      ],
    );
  }
  async listSdkProcesses(t: Tenant, since: Date): Promise<SdkProcessRecord[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM sdk_processes WHERE org_id = $1 AND project_id = $2 AND last_seen_at >= $3
        ORDER BY last_seen_at DESC LIMIT 5000`,
      [t.orgId, t.projectId, since],
    );
    return rows.map((r: Row) => ({
      orgId: r.org_id as string,
      projectId: r.project_id as string,
      service: r.service as string,
      environment: r.environment as string,
      instanceId: r.instance_id as string,
      startedAt: r.started_at as Date,
      firstSeenAt: r.first_seen_at as Date,
      lastSeenAt: r.last_seen_at as Date,
      lastEventAt: (r.last_event_at as Date | null) ?? null,
      sdkVersion: r.sdk_version as string,
      runtime: (r.runtime as string | null) ?? null,
      runtimeVersion: (r.runtime_version as string | null) ?? null,
      platform: (r.platform as string | null) ?? null,
      serverless: Boolean(r.serverless),
    }));
  }
  async recordServiceTemplates(t: Tenant, rows: ServiceTemplate[], at: Date) {
    if (rows.length === 0) return;
    const sorted = [...rows].sort((a, b) =>
      `${a.service}\u0000${a.environment}\u0000${a.provider}\u0000${a.host}\u0000${a.method}\u0000${a.endpoint}`.localeCompare(
        `${b.service}\u0000${b.environment}\u0000${b.provider}\u0000${b.host}\u0000${b.method}\u0000${b.endpoint}`,
      ),
    );
    await this.db.query(
      `INSERT INTO service_templates (org_id, project_id, service, environment, provider, host, method, endpoint, last_seen_at)
       SELECT $1, $2, s, e, p, h, m, ep, $9
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS u(s, e, p, h, m, ep)
       ON CONFLICT (org_id, project_id, service, environment, provider, host, method, endpoint)
       DO UPDATE SET last_seen_at = GREATEST(service_templates.last_seen_at, EXCLUDED.last_seen_at)`,
      [
        t.orgId,
        t.projectId,
        sorted.map((r) => r.service),
        sorted.map((r) => r.environment),
        sorted.map((r) => r.provider),
        sorted.map((r) => r.host),
        sorted.map((r) => r.method),
        sorted.map((r) => r.endpoint),
        at,
      ],
    );
  }
  async listServiceTemplates(t: Tenant, service: string, environment: string, since: Date) {
    const { rows } = await this.db.query(
      `SELECT service, environment, provider, host, method, endpoint FROM service_templates
        WHERE org_id = $1 AND project_id = $2 AND service = $3 AND environment = $4 AND last_seen_at >= $5
        LIMIT 50000`,
      [t.orgId, t.projectId, service, environment, since],
    );
    return rows as ServiceTemplate[];
  }
  async listServicesCalling(
    t: Tenant,
    environment: string,
    provider: string,
    endpoints: { method: string; endpoint: string }[],
    since: Date,
  ) {
    if (endpoints.length === 0) return [];
    const { rows } = await this.db.query(
      `SELECT DISTINCT service FROM service_templates
        WHERE org_id = $1 AND project_id = $2 AND environment = $3 AND provider = $4
          AND (method, endpoint) IN (SELECT * FROM unnest($5::text[], $6::text[]))
          AND last_seen_at >= $7
        ORDER BY service`,
      [
        t.orgId,
        t.projectId,
        environment,
        provider,
        endpoints.map((e) => e.method),
        endpoints.map((e) => e.endpoint),
        since,
      ],
    );
    return rows.map((r: Row) => r.service as string);
  }
  async pruneServiceTemplates(before: Date) {
    const { rowCount } = await this.db.query(
      `DELETE FROM service_templates WHERE last_seen_at < $1`,
      [before],
    );
    return rowCount ?? 0;
  }
  async pruneSdkProcesses(before: Date) {
    const { rowCount } = await this.db.query(`DELETE FROM sdk_processes WHERE last_seen_at < $1`, [
      before,
    ]);
    return rowCount ?? 0;
  }
  async listSdkInstances(t: Tenant): Promise<SdkInstanceRecord[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM sdk_instances WHERE org_id = $1 AND project_id = $2 ORDER BY service, environment`,
      [t.orgId, t.projectId],
    );
    return rows.map((r: Row) => ({
      orgId: r.org_id as string,
      projectId: r.project_id as string,
      service: r.service as string,
      environment: r.environment as string,
      sdkName: r.sdk_name as string,
      sdkVersion: r.sdk_version as string,
      firstSeenAt: r.first_seen_at as Date,
      lastSeenAt: r.last_seen_at as Date,
      lastEventAt: (r.last_event_at as Date | null) ?? null,
      droppedEvents: Number(r.dropped_events),
      lastFlushError: (r.last_flush_error as string | null) ?? null,
      serverless: Boolean(r.serverless),
      platform: (r.platform as string | null) ?? null,
      eventGapSeconds: r.event_gap_seconds === null ? null : Number(r.event_gap_seconds),
      eventBatches: Number(r.event_batches ?? 0),
    }));
  }

  async getMeta(key: string) {
    const { rows } = await this.db.query(`SELECT value FROM install_meta WHERE key = $1`, [key]);
    return (rows[0]?.value as string | undefined) ?? null;
  }
  async setMetaIfAbsent(key: string, value: string) {
    await this.db.query(
      `INSERT INTO install_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
    return (await this.getMeta(key)) ?? value;
  }
  async setMeta(key: string, value: string) {
    await this.db.query(
      `INSERT INTO install_meta (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  async deleteMetaPrefix(prefix: string) {
    await this.db.query(`DELETE FROM install_meta WHERE starts_with(key, $1)`, [prefix]);
  }
}

// ------------------------------------------------------------------ usage

class PgUsageStore implements UsageStore {
  constructor(private readonly db: Queryable) {}

  async add(t: Tenant, day: string, calls: number, dropped: number) {
    await this.db.query(
      `INSERT INTO usage_daily (org_id, project_id, day, calls_ingested, events_dropped_reported)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, project_id, day) DO UPDATE SET
         calls_ingested = usage_daily.calls_ingested + EXCLUDED.calls_ingested,
         events_dropped_reported = usage_daily.events_dropped_reported + EXCLUDED.events_dropped_reported`,
      [t.orgId, t.projectId, day, calls, dropped],
    );
  }
  async orgCallsSince(orgId: string, fromDay: string) {
    const { rows } = await this.db.query(
      `SELECT coalesce(sum(calls_ingested), 0)::bigint AS n FROM usage_daily WHERE org_id = $1 AND day >= $2`,
      [orgId, fromDay],
    );
    return Number(rows[0]?.n ?? 0);
  }
  async list(t: Tenant, fromDay: string) {
    const { rows } = await this.db.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, calls_ingested, events_dropped_reported FROM usage_daily
        WHERE org_id = $1 AND project_id = $2 AND day >= $3 ORDER BY day`,
      [t.orgId, t.projectId, fromDay],
    );
    return rows.map((r: Row) => ({
      day: r.day as string,
      callsIngested: Number(r.calls_ingested),
      eventsDroppedReported: Number(r.events_dropped_reported),
    }));
  }
}

// ------------------------------------------------------------------ storage

function bind(db: Queryable, pool: pg.Pool): Storage {
  const storage: Storage = {
    events: new PgEventStore(db),
    rollups: new PgRollupStore(db),
    incidents: new PgIncidentStore(db),
    config: new PgConfigStore(db),
    usage: new PgUsageStore(db),
    auth: new PgAuthStore(db),
    async transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
      if (db !== pool) return fn(storage); // already inside a transaction
      const client = await pool.connect();
      let result: T;
      try {
        await client.query('BEGIN');
        result = await fn(bind(client, pool));
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // a broken connection is destroyed rather than returned to the pool
        client.release(isStorageUnavailable(err) ? (err as Error) : undefined);
        throw err;
      }
      client.release();
      return result;
    },
    async withLeaderLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
      const client = await pool.connect();
      try {
        const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS got`, [
          name,
        ]);
        if (!rows[0]?.got) return null;
        try {
          return await fn();
        } finally {
          await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [name]).catch(() => {});
        }
      } finally {
        client.release();
      }
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
  return storage;
}

export interface PgOptions {
  connectionString: string;
  max?: number;
  connectionTimeoutMillis?: number;
}

export function createPgStorage(opts: PgOptions): { storage: Storage; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 3000,
    idleTimeoutMillis: 30_000,
  });
  // A client losing its connection emits 'error': on the pool while idle, on the
  // client itself while checked out. Unhandled, either would crash the process
  // (e.g. when Postgres restarts); the next query on it fails and it is discarded.
  pool.on('error', () => {});
  pool.on('connect', (client) => {
    client.on('error', () => {});
  });
  return { storage: bind(pool, pool), pool };
}
