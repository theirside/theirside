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

/**
 * Statuses counted one by one in rollups (behaviour-change detection), next to
 * 429 (`status429`) and the outcome counts: 3xx (part of `ok`) and the common
 * 4xx. Other 4xx stay only in `http_4xx`.
 */
export interface StatusCounts {
  s3xx: number;
  s400: number;
  s401: number;
  s403: number;
  s404: number;
  s409: number;
  s422: number;
}

export const STATUS_COUNT_KEYS = ['s3xx', 's400', 's401', 's403', 's404', 's409', 's422'] as const;

export function emptyStatusCounts(): StatusCounts {
  return { s3xx: 0, s400: 0, s401: 0, s403: 0, s404: 0, s409: 0, s422: 0 };
}

/** Count one call's status (weight `w`) into `c`. */
export function addStatus(c: StatusCounts, status: number | null, w = 1): void {
  if (status === null) return;
  if (status >= 300 && status < 400) c.s3xx += w;
  else if (status === 400) c.s400 += w;
  else if (status === 401) c.s401 += w;
  else if (status === 403) c.s403 += w;
  else if (status === 404) c.s404 += w;
  else if (status === 409) c.s409 += w;
  else if (status === 422) c.s422 += w;
}
