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
  /** Error rate must reach max(rateMultiplier × baseline, baseline + rateDeltaPp). */
  rateMultiplier: number;
  rateDeltaPp: number;
  /** One-sided binomial test vs baseline must be below this p-value. */
  maxPValue: number;
  /** Latency: p95 ≥ latencyMultiplier × baseline p95 and ≥ baseline + latencyDeltaMs. */
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
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  windowMinutes: 5,
  minCalls: 20,
  minErrors: 3,
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
