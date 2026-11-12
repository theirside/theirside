import { PROVIDER_ERROR_OUTCOMES, type Outcome } from '@theirside/shared';
import type { Incident, ProviderRecord } from '../../storage/types.js';
import {
  failureRate,
  normalRate,
  type BaselineView,
  type IncidentKind,
  type WindowStats,
} from '../scoring/evaluate.js';
import type { EndpointView } from './engine.js';

/** Formatting helpers shared by summaries, alerts and the dashboard. */
export function pct(x: number): string {
  const p = x * 100;
  if (p === 0) return '0%';
  if (p < 1) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

export function ms(x: number | null | undefined): string {
  if (x === null || x === undefined) return 'n/a';
  return x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`;
}

export function hhmm(d: Date): string {
  return `${d.toISOString().slice(11, 16)} UTC`;
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
}

const OUTCOME_LABEL: Partial<Record<Outcome, string>> = {
  http_5xx: '5xx',
  timeout: 'timeout',
  conn_reset: 'connection reset',
  conn_refused: 'connection refused',
  dns: 'DNS',
  tls: 'TLS',
};

/** e.g. "5xx 71%, timeout 29%" over provider errors in the window. */
export function outcomeBreakdown(outcomes: Record<Outcome, number>): string {
  const total = PROVIDER_ERROR_OUTCOMES.reduce((s, o) => s + (outcomes[o] ?? 0), 0);
  if (total === 0) return 'none';
  return PROVIDER_ERROR_OUTCOMES.filter((o) => (outcomes[o] ?? 0) > 0)
    .sort((a, b) => outcomes[b] - outcomes[a])
    .map((o) => `${OUTCOME_LABEL[o]} ${pct(outcomes[o] / total)}`)
    .join(', ');
}

export interface OthersStatus {
  /** Other endpoints of the provider with traffic in the window, none of them bad. */
  ok: boolean;
  text: string;
  degraded: string[];
}

/** "Other Acme Cards endpoints: OK." — the "it's them, and only this part" signal. */
export function othersStatus(
  provider: string,
  incident: Incident,
  views: readonly EndpointView[],
): OthersStatus {
  const inIncident = new Set(
    incident.endpoints.filter((e) => !e.recoveredAt).map((e) => `${e.method} ${e.endpoint}`),
  );
  const others = views.filter(
    (v) => !inIncident.has(`${v.method} ${v.endpoint}`) && (v.evals[0]?.stats.calls ?? 0) > 0,
  );
  if (others.length === 0) {
    return {
      ok: true,
      text: `No other ${provider} endpoints had traffic in the window.`,
      degraded: [],
    };
  }
  const degraded = others
    .filter((v) => v.evals[0]!.bad)
    .map((v) => `${v.method} ${v.endpoint} (${pct(v.evals[0]!.stats.errorRate)})`);
  if (degraded.length === 0)
    return { ok: true, text: `Other ${provider} endpoints: OK.`, degraded };
  return {
    ok: false,
    text: `Other ${provider} endpoints also degraded: ${degraded.join(', ')}.`,
    degraded,
  };
}

/**
 * What each kind says, never assigning blame: the status seen, and what it
 * usually means.
 */
const KIND_HINT: Partial<Record<IncidentKind, string>> = {
  auth: 'credentials may have expired or the provider changed access rules',
  not_found: 'the provider may have changed or removed this endpoint',
  validation: 'the provider may have changed its contract',
  rate_limited: 'the provider is limiting the rate of these calls',
  behaviour: 'the endpoint answers differently than usual',
};

const KIND_CODES: Partial<
  Record<IncidentKind, [keyof WindowStats['statusCounts'] | 's429', string][]>
> = {
  auth: [
    ['s401', '401'],
    ['s403', '403'],
  ],
  not_found: [['s404', '404']],
  validation: [
    ['s400', '400'],
    ['s422', '422'],
    ['s409', '409'],
  ],
  rate_limited: [['s429', '429']],
};

/** `401`, `401/403`: the statuses behind a 4xx incident, most frequent first. */
export function statusCodes(s: WindowStats, kind: IncidentKind): string {
  const codes = KIND_CODES[kind];
  if (!codes) return '';
  const count = (k: string) => (k === 's429' ? s.throttled : (s.statusCounts[k as 's401'] ?? 0));
  const seen = codes.filter(([k]) => count(k) > 0).sort((a, b) => count(b[0]) - count(a[0]));
  return (seen.length ? seen : codes.slice(0, 1)).map(([, c]) => c).join('/');
}

/** "400 (marked expected) now 95% of calls, normally 10%": the expected-outcome safety net. */
export function surgeText(s: WindowStats): string | null {
  const g = s.surge;
  if (!g) return null;
  return `${g.status} (marked expected) now ${pct(g.share)} of calls, normally ${pct(g.normalShare)}`;
}

/** "returns 401 for 62% of calls" / "62% of calls fail" for one endpoint's window. */
export function kindLine(s: WindowStats, b: BaselineView | null, kind: IncidentKind): string {
  const rate = pct(failureRate(s, kind));
  const normal = pct(b ? normalRate(b, kind) : 0);
  const surge = kind === 'behaviour' ? surgeText(s) : null;
  if (surge)
    return `${surge}: it is marked as a normal answer for this endpoint, but has taken over; the provider may have changed its contract`;
  if (kind === 'behaviour')
    return `${rate} of calls are not successful (normally ${normal}): ${KIND_HINT.behaviour}`;
  return `returns ${statusCodes(s, kind)} for ${rate} of calls (normally ${normal}); ${KIND_HINT[kind]}`;
}

/** Calls far above normal volume (a retry loop?) and failures far faster than normal responses. */
export function sideSignals(
  s: WindowStats,
  b: BaselineView | null,
  windowMinutes: number,
  kind: IncidentKind,
): string[] {
  const out: string[] = [];
  // only against a learned normal: a young baseline's volume and latency aren't "normal" yet
  if (!b || b.learning || s.calls === 0) return out;
  const perMin = s.calls / Math.max(1, windowMinutes);
  if (b.callsPerMin && b.callsPerMin > 0 && perMin >= 3 * b.callsPerMin && perMin >= 1)
    out.push(
      `Call volume ${Math.round(perMin * 10) / 10}/min, ${Math.round(perMin / b.callsPerMin)}× normal (often a retry loop in the caller).`,
    );
  // the median: right after a change the window still holds slower calls from before it
  if (
    kind !== 'latency' &&
    b.p50Ms !== null &&
    b.p50Ms >= 100 &&
    s.p50 !== null &&
    s.p50 <= 0.3 * b.p50Ms
  )
    out.push(
      `Responses are fast (median ${ms(s.p50)}, normally ${ms(b.p50Ms)}): calls fail before doing work.`,
    );
  return out;
}

export interface SummaryInput {
  incident: Incident;
  views: readonly EndpointView[];
  provider: ProviderRecord | null;
  sampleRequestIds: string[];
  now: Date;
}

/**
 * Plain-text summary, ready to paste into an email to the provider:
 *
 *   Acme Cards — POST /v2/cards/:id/activate failing since 14:02 UTC (6 min)
 *   Error rate 38% (normal 0.2%), 412 calls in window. Outcomes: 5xx 71%, timeout 29%.
 *   p95 latency 8.1 s (normal 420 ms). Other Acme Cards endpoints: OK.
 *   Sample provider request IDs: req_8f2..., req_91a..., req_0cd...
 *   Support: support@acmecards.com
 */
export function buildSummary(input: SummaryInput): string {
  const { incident: inc, views, provider, sampleRequestIds, now } = input;
  const name = inc.provider;
  const byKey = new Map(views.map((v) => [`${v.method} ${v.endpoint}`, v]));
  const endpoints =
    inc.status === 'open' ? inc.endpoints.filter((e) => !e.recoveredAt) : inc.endpoints;
  const lines: string[] = [];

  const what =
    endpoints.length === 1
      ? `${endpoints[0]!.method} ${endpoints[0]!.endpoint}`
      : `${endpoints.length} endpoints`;
  const verb =
    inc.kind === 'latency'
      ? 'slow'
      : inc.kind === 'errors'
        ? 'failing'
        : inc.kind === 'behaviour'
          ? 'answering differently'
          : `answering ${KIND_CODES[inc.kind]!.map(([, c]) => c).join('/')}`;
  if (inc.status === 'resolved' && inc.resolvedAt) {
    lines.push(
      `${name} — ${what} recovered at ${hhmm(inc.resolvedAt)} after ${minutesBetween(inc.openedAt, inc.resolvedAt)} min (${verb} since ${hhmm(inc.openedAt)})`,
    );
    const peak =
      inc.kind === 'errors' || inc.kind === 'latency'
        ? `Peak error rate ${pct(inc.peakErrorRate)}`
        : inc.kind === 'behaviour'
          ? `Peak share of unsuccessful calls ${pct(inc.peakErrorRate)}`
          : `Peak share of ${KIND_CODES[inc.kind]!.map(([, c]) => c).join('/')} ${pct(inc.peakErrorRate)}`;
    lines.push(`${peak}${inc.peakP95Ms ? `, peak p95 latency ${ms(inc.peakP95Ms)}` : ''}.`);
  } else {
    lines.push(
      `${name} — ${what} ${verb} since ${hhmm(inc.openedAt)} (${minutesBetween(inc.openedAt, now)} min)`,
    );
    for (const e of endpoints) {
      const v = byKey.get(`${e.method} ${e.endpoint}`);
      const s = v?.evals[0]?.stats;
      const b = v?.baseline ?? null;
      const prefix = endpoints.length > 1 ? `${e.method} ${e.endpoint}: ` : '';
      if (!s) {
        lines.push(`${prefix}no traffic in the current window.`);
        continue;
      }
      const window =
        (v?.evals[0]?.windowMinutes ?? 5) > 5
          ? `${s.calls} calls in the last ${v!.evals[0]!.windowMinutes} min (low volume: too few calls in 5 min, so judged over ${v!.evals[0]!.windowMinutes})`
          : `${s.calls} calls in window`;
      if (inc.kind === 'errors' || inc.kind === 'latency') {
        lines.push(
          `${prefix}Error rate ${pct(s.errorRate)} (normal ${pct(b?.providerErrorRate ?? 0)}${b?.learning ? ', still learning' : ''}), ${window}. Outcomes: ${outcomeBreakdown(s.outcomes)}.`,
        );
      } else {
        const line = kindLine(s, b, inc.kind);
        lines.push(`${prefix}${line[0]!.toUpperCase()}${line.slice(1)}; ${window}.`);
      }
      lines.push(`${prefix}p95 latency ${ms(s.p95)} (normal ${ms(b?.p95Ms)}).`);
      for (const sig of sideSignals(s, b, v?.evals[0]?.windowMinutes ?? 5, inc.kind))
        lines.push(`${prefix}${sig}`);
    }
    lines[lines.length - 1] += ` ${othersStatus(name, inc, views).text}`;
  }
  if (inc.deployHint) lines.push(inc.deployHint);
  if (sampleRequestIds.length > 0)
    lines.push(`Sample provider request IDs: ${sampleRequestIds.join(', ')}`);
  const support = [provider?.supportEmail, provider?.supportUrl].filter(Boolean).join(', ');
  if (support) lines.push(`Support: ${support}`);
  return lines.join('\n');
}
