export const OUTCOMES = [
  'ok',
  'http_4xx',
  'http_5xx',
  'timeout',
  'conn_reset',
  'conn_refused',
  'dns',
  'tls',
  'aborted',
  'other_error',
] as const;

export type Outcome = (typeof OUTCOMES)[number];

/** Outcomes that count against the provider (architecture §7). */
export const PROVIDER_ERROR_OUTCOMES: readonly Outcome[] = [
  'http_5xx',
  'timeout',
  'conn_reset',
  'conn_refused',
  'dns',
  'tls',
];

const providerErrorSet = new Set<Outcome>(PROVIDER_ERROR_OUTCOMES);

export function isProviderError(outcome: Outcome): boolean {
  return providerErrorSet.has(outcome);
}

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

/** Outcome for a received HTTP status. */
export function outcomeForStatus(status: number): Outcome {
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'ok';
}
