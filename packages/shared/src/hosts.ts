/**
 * Provider host patterns: exact host (`api.acme.com`), wildcard subdomain
 * (`*.acme.io`, any depth, not the apex) or either form with a port
 * (`localhost:4010`). Matching is case-insensitive.
 */
export type HostMatcher = (hostname: string, port: string) => boolean;

export function compileHostPattern(pattern: string): HostMatcher {
  const p = pattern.trim().toLowerCase();
  const colon = p.lastIndexOf(':');
  const hasPort = colon !== -1 && /^\d+$/.test(p.slice(colon + 1));
  const hostPart = hasPort ? p.slice(0, colon) : p;
  const portPart = hasPort ? p.slice(colon + 1) : null;

  const hostMatches: (h: string) => boolean = hostPart.startsWith('*.')
    ? (
        (suffix) => (h) =>
          h.endsWith(suffix) && h.length > suffix.length
      )(hostPart.slice(1))
    : (h) => h === hostPart;

  return (hostname, port) => {
    if (portPart !== null && port !== portPart) return false;
    return hostMatches(hostname.toLowerCase());
  };
}

export interface ProviderMatcher<T> {
  readonly value: T;
  readonly matchers: HostMatcher[];
}

/** First provider whose patterns match wins. */
export function findProvider<T>(
  providers: readonly ProviderMatcher<T>[],
  hostname: string,
  port: string,
): T | undefined {
  for (const p of providers) {
    for (const m of p.matchers) if (m(hostname, port)) return p.value;
  }
  return undefined;
}
