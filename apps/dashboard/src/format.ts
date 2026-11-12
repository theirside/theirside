export function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return '–';
  const p = x * 100;
  if (p === 0) return '0%';
  if (p < 1) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

export function ms(x: number | null | undefined): string {
  if (x === null || x === undefined) return '–';
  return x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`;
}

export function num(x: number): string {
  return x >= 100 ? Math.round(x).toLocaleString() : String(Math.round(x * 10) / 10);
}

/**
 * "Now" for relative times: the browser's clock, or the simulated clock in simulation
 * mode (the banner keeps it current), so "3 min ago" means simulated minutes.
 */
let nowSource: () => number = () => Date.now();
export const nowMs = () => nowSource();
export function setNowSource(fn: () => number): void {
  nowSource = fn;
}

export function ago(iso: string | null): string {
  if (!iso) return '–';
  const s = Math.round((nowMs() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function when(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** Incident kinds as people say them (collector: scoring/evaluate.ts). */
export const KIND_LABEL: Record<string, string> = {
  errors: 'outage',
  latency: 'slowness',
  auth: 'auth errors',
  not_found: 'not found',
  validation: 'validation errors',
  rate_limited: 'rate limited',
  behaviour: 'behaviour change',
  webhook_silence: 'webhooks silent',
  webhook_rejections: 'webhooks rejected',
  webhook_slow: 'webhooks slow',
  webhook_lag: 'webhooks late',
};

/** "2h 10m", "45m", "3d 4h" (as in alerts). */
export function gap(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const h = Math.floor(m / 60);
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/** Seconds of delivery lag: "2 s", "6m 20s"-style via gap(). */
export function lag(s: number | null | undefined): string {
  if (s === null || s === undefined) return '–';
  return s < 60 ? `${Math.round(s)} s` : gap(s / 60);
}

/** Failure groups of the status-mix chart. */
export const GROUP_LABEL: Record<string, string> = {
  outage: '5xx / network',
  auth: '401/403',
  not_found: '404',
  validation: '400/409/422',
  rate_limited: '429',
  client_other: 'other 4xx',
};
