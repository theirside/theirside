import { PROVIDER_ERROR_OUTCOMES, type Outcome } from '@theirside/shared';
import type { Incident, ProviderRecord } from '../../storage/types.js';
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
  const verb = inc.kind === 'latency' ? 'slow' : 'failing';
  if (inc.status === 'resolved' && inc.resolvedAt) {
    lines.push(
      `${name} — ${what} recovered at ${hhmm(inc.resolvedAt)} after ${minutesBetween(inc.openedAt, inc.resolvedAt)} min (${verb} since ${hhmm(inc.openedAt)})`,
    );
    lines.push(
      `Peak error rate ${pct(inc.peakErrorRate)}${inc.peakP95Ms ? `, peak p95 latency ${ms(inc.peakP95Ms)}` : ''}.`,
    );
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
      lines.push(
        `${prefix}Error rate ${pct(s.errorRate)} (normal ${pct(b?.providerErrorRate ?? 0)}${b?.learning ? ', still learning' : ''}), ${s.calls} calls in window. Outcomes: ${outcomeBreakdown(s.outcomes)}.`,
      );
      lines.push(`${prefix}p95 latency ${ms(s.p95)} (normal ${ms(b?.p95Ms)}).`);
    }
    lines[lines.length - 1] += ` ${othersStatus(name, inc, views).text}`;
  }
  if (sampleRequestIds.length > 0)
    lines.push(`Sample provider request IDs: ${sampleRequestIds.join(', ')}`);
  const support = [provider?.supportEmail, provider?.supportUrl].filter(Boolean).join(', ');
  if (support) lines.push(`Support: ${support}`);
  return lines.join('\n');
}
