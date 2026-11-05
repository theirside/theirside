import {
  OUTCOMES,
  bucketIndex,
  emptyHistogram,
  type Outcome,
  type ParsedIngestBatch,
} from '@theirside/shared';
import type { RollupDelta, StoredEvent } from '../../storage/types.js';
import { floorMinute } from '../../util/clock.js';

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
  /** Events dropped: excluded, hidden or internal hosts. */
  dropped: number;
}

/**
 * Provider for an event: the SDK's name (null when it must not be stored, e.g.
 * a provider marked hidden), or, for discovered hosts (`provider: null`), the
 * collector's assignment.
 */
export type ProviderResolver = (provider: string | null, host: string) => string | null;

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
): PreparedBatch {
  const recv = receivedAt.getTime();
  const okWeight = Math.max(1, Math.round(1 / (batch.sampleRate ?? 1)));
  const events: StoredEvent[] = [];
  const deltas = new Map<string, RollupDelta>();
  const providers = new Map<string, string>();
  let calls = 0;
  let dropped = 0;

  for (const e of batch.events) {
    const provider = resolveProvider(e.provider, e.host);
    if (provider === null) {
      dropped++;
      continue;
    }
    let ts = e.ts;
    if (ts > recv + MAX_FUTURE_SKEW_MS || ts < recv - MAX_PAST_SKEW_MS) ts = recv;
    const environment = e.environment ?? batch.environment;
    const method = e.method.toUpperCase();
    events.push({
      ts: new Date(ts),
      service: e.service ?? batch.service,
      environment,
      sdkVersion: e.sdkVersion ?? batch.sdk.version,
      provider,
      host: e.host,
      method,
      endpoint: e.endpoint,
      status: e.status,
      durationMs: e.durationMs,
      outcome: e.outcome,
      errorCode: e.errorCode ?? null,
      correlationId: e.correlationId ?? null,
      providerRequestId: e.providerRequestId ?? null,
    });
    if (!providers.has(provider)) providers.set(provider, e.host);

    const minute = new Date(floorMinute(ts)).toISOString();
    const key = `${environment}\u0000${provider}\u0000${e.endpoint}\u0000${method}\u0000${minute}`;
    let d = deltas.get(key);
    if (!d) {
      d = {
        environment,
        provider,
        endpoint: e.endpoint,
        method,
        minute,
        total: 0,
        ok: 0,
        outcomes: emptyOutcomes(),
        status429: 0,
        latencyHistogram: emptyHistogram(),
        latencySumMs: 0,
      };
      deltas.set(key, d);
    }
    const w = e.outcome === 'ok' ? okWeight : 1;
    d.total += w;
    d.outcomes[e.outcome] += w;
    if (e.outcome === 'ok') d.ok += w;
    if (e.status === 429) d.status429 += w;
    d.latencyHistogram[bucketIndex(e.durationMs)]! += w;
    d.latencySumMs += e.durationMs * w;
    calls += w;
  }
  return { events, deltas: [...deltas.values()], calls, providers, dropped };
}
