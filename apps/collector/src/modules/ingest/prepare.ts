import {
  OUTCOMES,
  addStatus,
  emptyStatusCounts,
  bucketIndex,
  collapseSlashes,
  emptyHistogram,
  type Outcome,
  type ParsedIngestBatch,
} from '@theirside/shared';
import type {
  CandidateDelta,
  InboundKey,
  InboundRollupRow,
  RollupDelta,
  StoredEvent,
} from '../../storage/types.js';
import { floorMinute } from '../../util/clock.js';

/** Reason labels kept per rollup key in one batch (expected outcomes); more count as `other`. */
export const MAX_EXPECTED_REASONS = 10;

/** Event timestamps further than this from receive time are clamped to receive time. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
export const MAX_PAST_SKEW_MS = 24 * 3600_000;

export interface PreparedBatch {
  events: StoredEvent[];
  deltas: RollupDelta[];
  /** Calls represented, with sampled successes weighted back up. */
  calls: number;
  /** Provider name → a host seen for it, to auto-create provider rows. */
  providers: Map<string, string>;
  /** Provider name → its latest (clamped) call time in the batch. */
  lastCalls: Map<string, Date>;
  /** Events dropped: excluded, hidden or internal hosts. */
  dropped: number;
  /** Inbound webhook rollups per (environment, provider, route, minute). */
  inbound: InboundRollupRow[];
  /** Inbound sources seen: latest delivery and the service that received it. */
  sources: (InboundKey & { lastDeliveryAt: Date; service: string })[];
  /** Providers seen only as webhook senders (rows created without a host). */
  inboundProviders: Set<string>;
  /** Webhook discovery: candidate reports per route and UTC day (never scored). */
  candidates: CandidateDelta[];
}

function emptyInbound(k: InboundKey, minute: string): InboundRollupRow {
  return {
    ...k,
    minute,
    total: 0,
    accepted: 0,
    rejected: 0,
    status3xx: 0,
    status401: 0,
    status403: 0,
    status4xx: 0,
    status5xx: 0,
    unanswered: 0,
    durationHistogram: emptyHistogram(),
    durationSumMs: 0,
    lagCount: 0,
    lagSumS: 0,
    lagHistogram: emptyHistogram(),
  };
}

/** Count one inbound delivery into its rollup (docs/scoring.md "Webhooks"). */
export function addDelivery(
  r: InboundRollupRow,
  status: number | null,
  durationMs: number,
  lagMs: number | null,
): void {
  r.total += 1;
  if (status !== null && status >= 200 && status < 300) r.accepted += 1;
  else r.rejected += 1;
  if (status === null) r.unanswered += 1;
  else if (status >= 300 && status < 400) r.status3xx += 1;
  else if (status === 401) r.status401 += 1;
  else if (status === 403) r.status403 += 1;
  else if (status >= 400 && status < 500) r.status4xx += 1;
  else if (status >= 500) r.status5xx += 1;
  r.durationHistogram[bucketIndex(durationMs)]! += 1;
  r.durationSumMs += durationMs;
  if (lagMs !== null) {
    // a sender clock slightly ahead gives a small negative lag: counted as none
    const s = Math.max(0, lagMs) / 1000;
    r.lagCount += 1;
    r.lagSumS += s;
    r.lagHistogram[bucketIndex(s)]! += 1;
  }
}

/**
 * Provider for an event: the SDK's name (null when it must not be stored, e.g.
 * a provider marked hidden), or, for discovered hosts (`provider: null`), the
 * collector's assignment.
 */
export type ProviderResolver = (provider: string | null, host: string) => string | null;

/**
 * The endpoint template to store for a provider's call: merged templates are
 * rewritten to the template they were merged into (provider `endpointAliases`).
 */
export type EndpointRewriter = (provider: string, method: string, endpoint: string) => string;

/** Without auto-discovery data: SDK names as they are, discovered hosts under their host. */
export const passThrough: ProviderResolver = (provider, host) => provider ?? host;

function emptyOutcomes(): Record<Outcome, number> {
  const o = {} as Record<Outcome, number>;
  for (const k of OUTCOMES) o[k] = 0;
  return o;
}

/**
 * Pure transformation of a validated batch: fill per-event service/env/sdk from
 * the header, clamp implausible clocks, and aggregate rollup deltas per
 * (environment, provider, endpoint, method, minute). Successes are weighted by
 * round(1 / sampleRate) in rollups; raw events stay one row per event.
 */
export function prepareBatch(
  batch: ParsedIngestBatch,
  receivedAt: Date,
  resolveProvider: ProviderResolver = passThrough,
  rewriteEndpoint?: EndpointRewriter,
): PreparedBatch {
  const recv = receivedAt.getTime();
  const okWeight = Math.max(1, Math.round(1 / (batch.sampleRate ?? 1)));
  const events: StoredEvent[] = [];
  const deltas = new Map<string, RollupDelta>();
  const providers = new Map<string, string>();
  const lastCalls = new Map<string, Date>();
  const inbound = new Map<string, InboundRollupRow>();
  const sources = new Map<string, InboundKey & { lastDeliveryAt: Date; service: string }>();
  const inboundProviders = new Set<string>();
  const candidates = new Map<string, CandidateDelta>();
  let calls = 0;
  let dropped = 0;

  for (const e of batch.events) {
    if (e.direction === 'inbound' && e.candidate) {
      // webhook discovery: a route to confirm or ignore, not a delivery from a known sender.
      // No raw event, rollup, source or provider row, and not counted as calls.
      let ts = e.ts;
      if (ts > recv + MAX_FUTURE_SKEW_MS || ts < recv - MAX_PAST_SKEW_MS) ts = recv;
      const endpoint = collapseSlashes(e.endpoint);
      const day = new Date(ts).toISOString().slice(0, 10);
      const key = `${endpoint}\u0000${day}`;
      const name = e.provider && e.provider !== 'unknown' ? e.provider : null;
      const cur = candidates.get(key);
      const n = e.count ?? 1;
      if (!cur)
        candidates.set(key, {
          endpoint,
          method: e.method.toUpperCase(),
          suggestedName: name,
          day,
          deliveries: n,
          lastAt: new Date(ts),
          service: e.service ?? batch.service,
        });
      else {
        cur.deliveries += n;
        if (ts > cur.lastAt.getTime()) cur.lastAt = new Date(ts);
        cur.suggestedName ??= name;
      }
      continue;
    }
    if (e.direction === 'inbound') {
      // the SDK names the sender; hidden providers are dropped like their calls
      const provider = e.provider === null ? null : resolveProvider(e.provider, e.host);
      if (provider === null) {
        dropped++;
        continue;
      }
      let ts = e.ts;
      if (ts > recv + MAX_FUTURE_SKEW_MS || ts < recv - MAX_PAST_SKEW_MS) ts = recv;
      const environment = e.environment ?? batch.environment;
      const service = e.service ?? batch.service;
      const endpoint = collapseSlashes(e.endpoint);
      // lag against the SDK's receive time, not ours (no batching delay in it)
      const lagMs = e.sentAt !== undefined ? ts - e.sentAt : null;
      events.push({
        ts: new Date(ts),
        service,
        environment,
        sdkVersion: e.sdkVersion ?? batch.sdk.version,
        provider,
        host: e.host,
        method: e.method.toUpperCase(),
        endpoint,
        status: e.status,
        durationMs: e.durationMs,
        outcome: e.outcome,
        errorCode: null,
        correlationId: null,
        providerRequestId: null,
        direction: 'inbound',
        sentAt: e.sentAt !== undefined ? new Date(e.sentAt) : null,
      });
      inboundProviders.add(provider);
      const k = { environment, provider, endpoint };
      const minute = new Date(floorMinute(ts)).toISOString();
      const id = `${environment}\u0000${provider}\u0000${endpoint}`;
      let r = inbound.get(`${id}\u0000${minute}`);
      if (!r) inbound.set(`${id}\u0000${minute}`, (r = emptyInbound(k, minute)));
      addDelivery(r, e.status, e.durationMs, lagMs);
      const src = sources.get(id);
      if (!src || ts > src.lastDeliveryAt.getTime())
        sources.set(id, { ...k, lastDeliveryAt: new Date(ts), service });
      calls += 1;
      continue;
    }
    const provider = resolveProvider(e.provider, e.host);
    if (provider === null) {
      dropped++;
      continue;
    }
    let ts = e.ts;
    if (ts > recv + MAX_FUTURE_SKEW_MS || ts < recv - MAX_PAST_SKEW_MS) ts = recv;
    const environment = e.environment ?? batch.environment;
    const method = e.method.toUpperCase();
    // SDKs before 0.1.1 keep the empty segment of `//` (base URL ending in `/`)
    let endpoint = collapseSlashes(e.endpoint);
    if (rewriteEndpoint) endpoint = rewriteEndpoint(provider, method, endpoint);
    // expected outcomes: only a 4xx can be a business answer (never 5xx, timeouts, network)
    const expected = e.expected !== undefined && e.outcome === 'http_4xx' ? e.expected : null;
    events.push({
      ts: new Date(ts),
      service: e.service ?? batch.service,
      environment,
      sdkVersion: e.sdkVersion ?? batch.sdk.version,
      provider,
      host: e.host,
      method,
      endpoint,
      status: e.status,
      durationMs: e.durationMs,
      outcome: e.outcome,
      errorCode: e.errorCode ?? null,
      correlationId: e.correlationId ?? null,
      providerRequestId: e.providerRequestId ?? null,
      ...(expected ? { expected } : {}),
    });
    if (!providers.has(provider)) providers.set(provider, e.host);
    if (ts > (lastCalls.get(provider)?.getTime() ?? 0)) lastCalls.set(provider, new Date(ts));

    const minute = new Date(floorMinute(ts)).toISOString();
    const key = `${environment}\u0000${provider}\u0000${endpoint}\u0000${method}\u0000${minute}`;
    let d = deltas.get(key);
    if (!d) {
      d = {
        environment,
        provider,
        endpoint,
        method,
        minute,
        total: 0,
        ok: 0,
        outcomes: emptyOutcomes(),
        status429: 0,
        statusCounts: emptyStatusCounts(),
        expected: 0,
        latencyHistogram: emptyHistogram(),
        latencySumMs: 0,
      };
      deltas.set(key, d);
    }
    const w = e.outcome === 'ok' ? okWeight : 1;
    d.total += w;
    if (expected) {
      // a business answer: successful for every rule and score, kept apart per reason
      d.outcomes.ok += w;
      d.ok += w;
      d.expected = (d.expected ?? 0) + w;
      const reasons = (d.expectedReasons ??= {});
      const r =
        reasons[expected] !== undefined || Object.keys(reasons).length < MAX_EXPECTED_REASONS
          ? expected
          : 'other';
      reasons[r] = (reasons[r] ?? 0) + w;
    } else {
      d.outcomes[e.outcome] += w;
      if (e.outcome === 'ok') d.ok += w;
      if (e.status === 429) d.status429 += w;
      addStatus(d.statusCounts!, e.status, w);
    }
    d.latencyHistogram[bucketIndex(e.durationMs)]! += w;
    d.latencySumMs += e.durationMs * w;
    calls += w;
  }
  for (const p of providers.keys()) inboundProviders.delete(p);
  return {
    events,
    deltas: [...deltas.values()],
    calls,
    providers,
    lastCalls,
    dropped,
    inbound: [...inbound.values()],
    sources: [...sources.values()],
    inboundProviders,
    candidates: [...candidates.values()],
  };
}
