/**
 * Incident and scoring thresholds (docs/scoring.md). Defaults below; each can be
 * overridden per project in `settings.thresholds` (same keys).
 */
export interface Thresholds {
  /** Window length for rates and p95, minutes. */
  windowMinutes: number;
  /** Minimum calls in the window before anything can open an incident. */
  minCalls: number;
  /** Minimum provider errors in the window for an error incident. */
  minErrors: number;
  /**
   * Count test (every rate rule, slow calls and late deliveries included): failures at
   * least this many above the count the normal share predicts for the window.
   */
  minExcess: number;
  /** Error rate must reach max(rateMultiplier × baseline, baseline + rateDeltaPp). */
  rateMultiplier: number;
  rateDeltaPp: number;
  /** One-sided count test (beta-binomial) vs baseline must be below this p-value. */
  maxPValue: number;
  /**
   * Latency: a call is slow above max(latencyMultiplier × normal p95, normal p95 +
   * latencyDeltaMs); slow calls are counted against their normal share.
   */
  latencyMultiplier: number;
  latencyDeltaMs: number;
  /** Consecutive bad minutes to open. */
  openAfterMinutes: number;
  /** Consecutive healthy minutes to resolve (per endpoint). */
  resolveAfterMinutes: number;
  /** After an endpoint recovers, a new incident on it within this time is tracked but not alerted. */
  cooldownMinutes: number;
  /** Baseline history. */
  baselineDays: number;
  /** Minutes before now excluded from the baseline (an emerging incident must not teach the baseline). */
  baselineGapMinutes: number;
  /** Learning until both are reached. */
  learningMinHours: number;
  learningMinCalls: number;
  /** Provider-error rate floor used while learning (max(observed, this)). */
  learningDefaultRate: number;
  /** Floor for the binomial test's null rate (a 0% baseline would make any error "significant"). */
  minBaselineRate: number;
  /** Escalate when the error rate (or p95) reaches this multiple of the last alerted value. */
  escalationFactor: number;
  // ---- inbound webhooks (docs/scoring.md "Webhooks"); the rules above apply to them too
  /** Silence: history the hour-of-week profile is learned from. */
  silenceHistoryDays: number;
  /** Silence is judged only with at least this much history … */
  silenceMinHistoryDays: number;
  /** … and this many deliveries in it (naturally rare sources never page). */
  silenceMinDeliveries: number;
  /** Silence never opens before this many minutes without a delivery. */
  silenceMinGapMinutes: number;
  /**
   * Delivery lag: a delivery is late above max(lagMultiplier × normal p95 lag, normal +
   * lagDeltaSeconds); late deliveries are counted against their normal share.
   */
  lagMultiplier: number;
  lagDeltaSeconds: number;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  windowMinutes: 5,
  minCalls: 20,
  minErrors: 3,
  minExcess: 5,
  rateMultiplier: 5,
  rateDeltaPp: 0.05,
  maxPValue: 0.001,
  latencyMultiplier: 3,
  latencyDeltaMs: 1000,
  openAfterMinutes: 3,
  resolveAfterMinutes: 10,
  cooldownMinutes: 30,
  baselineDays: 7,
  baselineGapMinutes: 15,
  learningMinHours: 24,
  learningMinCalls: 500,
  learningDefaultRate: 0.01,
  minBaselineRate: 0.001,
  escalationFactor: 2,
  silenceHistoryDays: 28,
  silenceMinHistoryDays: 21,
  silenceMinDeliveries: 100,
  silenceMinGapMinutes: 15,
  lagMultiplier: 3,
  lagDeltaSeconds: 60,
});

/**
 * What one provider may override (Settings → Providers → Alerts & thresholds),
 * with the accepted range. Everything else is per project only.
 */
export const PROVIDER_THRESHOLD_LIMITS = {
  minCalls: { min: 1, max: 1_000_000, integer: true },
  openAfterMinutes: { min: 1, max: 60, integer: true },
  rateMultiplier: { min: 1, max: 1000, integer: false },
  rateDeltaPp: { min: 0, max: 1, integer: false },
  latencyMultiplier: { min: 1, max: 1000, integer: false },
  latencyDeltaMs: { min: 0, max: 600_000, integer: true },
} as const;
export type ProviderThresholdKey = keyof typeof PROVIDER_THRESHOLD_LIMITS;
export type ProviderThresholds = Partial<Record<ProviderThresholdKey, number>>;
export const PROVIDER_THRESHOLD_KEYS = Object.keys(
  PROVIDER_THRESHOLD_LIMITS,
) as ProviderThresholdKey[];

/**
 * What one provider may override for its inbound webhooks (Settings → Providers →
 * Webhooks), separate from its outgoing overrides: a low minimum set for a
 * provider's API traffic says nothing about how often it sends webhooks.
 */
export const WEBHOOK_THRESHOLD_LIMITS = {
  ...PROVIDER_THRESHOLD_LIMITS,
  silenceMinGapMinutes: { min: 1, max: 30 * 24 * 60, integer: true },
  lagMultiplier: { min: 1, max: 1000, integer: false },
  lagDeltaSeconds: { min: 0, max: 7 * 24 * 3600, integer: true },
} as const;
export type WebhookThresholdKey = keyof typeof WEBHOOK_THRESHOLD_LIMITS;
export const WEBHOOK_THRESHOLD_KEYS = Object.keys(
  WEBHOOK_THRESHOLD_LIMITS,
) as WebhookThresholdKey[];

/** A provider's webhook thresholds: its webhook overrides, then the project's. */
export function webhookThresholdsFor(
  project: Thresholds,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Thresholds {
  if (!overrides) return project;
  let t = project;
  for (const key of WEBHOOK_THRESHOLD_KEYS) {
    const v = overrides[key];
    const lim = WEBHOOK_THRESHOLD_LIMITS[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lim.min || v > lim.max) continue;
    if (t === project) t = { ...project };
    t[key] = v;
  }
  return t;
}

/**
 * A provider's thresholds: its own overrides first, then the project's
 * (`project`, already resolved: project overrides over the defaults).
 * Keys a provider may not override, and values out of range, are ignored.
 */
export function thresholdsFor(
  project: Thresholds,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Thresholds {
  if (!overrides) return project;
  let t = project;
  for (const key of PROVIDER_THRESHOLD_KEYS) {
    const v = overrides[key];
    const lim = PROVIDER_THRESHOLD_LIMITS[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lim.min || v > lim.max) continue;
    if (t === project) t = { ...project };
    t[key] = v;
  }
  return t;
}

/** Merge per-project overrides; unknown keys and wrong types are ignored. */
export function resolveThresholds(overrides: Record<string, unknown> | undefined): Thresholds {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS };
  if (!overrides) return t;
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    const v = overrides[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) t[key] = v;
  }
  return t;
}
