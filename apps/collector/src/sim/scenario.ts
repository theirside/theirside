/**
 * Simulation scenarios (docs/demo.md "Simulate weeks in minutes"): YAML files in
 * examples/sim/ and the Simulation page's scenarios, one format for both. Times
 * are relative to `start` ("day 9 14:00", "+9d14h") or absolute ISO 8601;
 * durations are "30m", "2h", "3d", "1w" or combinations ("1d6h").
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const PATTERNS = ['steady', 'daily', 'low', 'bursty', 'test-bursts', 'rare', 'off'] as const;
export type Pattern = (typeof PATTERNS)[number];

export const OUTBOUND_FAULTS = [
  '5xx',
  'timeouts',
  'resets',
  'auth',
  'not_found',
  'validation',
  'latency',
] as const;
export const INBOUND_FAULTS = ['silent', 'rejected', 'slow', 'late'] as const;
export type OutboundFaultType = (typeof OUTBOUND_FAULTS)[number];
export type InboundFaultType = (typeof INBOUND_FAULTS)[number];
export type FaultType = OutboundFaultType | InboundFaultType;

/** "1w2d3h30m" → ms. */
export function parseDuration(s: string | number): number {
  if (typeof s === 'number') return s * MIN;
  const re = /(\d+(?:\.\d+)?)\s*(w|d|h|m|s)/g;
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(re)) {
    const v = Number(m[1]);
    total +=
      v * { w: 7 * DAY, d: DAY, h: HOUR, m: MIN, s: 1000 }[m[2] as 'w' | 'd' | 'h' | 'm' | 's'];
    matched += m[0];
  }
  if (!matched || matched.replace(/\s/g, '') !== s.replace(/\s/g, ''))
    throw new Error(`bad duration "${s}" (use e.g. 30m, 2h, 3d, 1w2d)`);
  return total;
}

/** "day 9 14:00" | "d9" | "+9d14h" | ISO → epoch ms, relative to `start`. */
export function parseTime(s: string | number, start: number): number {
  if (typeof s === 'number') return start + s * MIN;
  const t = s.trim();
  const day = /^(?:day|d)\s*(\d+)(?:\s+(\d{1,2}):(\d{2}))?$/i.exec(t);
  if (day)
    return start + Number(day[1]) * DAY + Number(day[2] ?? 0) * HOUR + Number(day[3] ?? 0) * MIN;
  if (t.startsWith('+')) return start + parseDuration(t.slice(1));
  const abs = Date.parse(t);
  if (Number.isFinite(abs)) return abs;
  throw new Error(`bad time "${s}" (use "day 9 14:00", "+9d14h" or an ISO time)`);
}

/** Epoch ms → "day 9 14:00" relative to `start`. */
export function formatTime(ms: number, start: number): string {
  const off = ms - start;
  const d = Math.floor(off / DAY);
  const rest = off - d * DAY;
  const hh = String(Math.floor(rest / HOUR)).padStart(2, '0');
  const mm = String(Math.floor((rest % HOUR) / MIN)).padStart(2, '0');
  return `day ${d} ${hh}:${mm}`;
}

const time = z.union([z.string(), z.number()]);
const duration = z.union([z.string(), z.number()]);

export const trafficSchema = z.object({
  pattern: z.enum(PATTERNS),
  /** Calls (deliveries) per minute: flat for steady, at the daily peak for daily, during a burst for test-bursts, on average for bursty. */
  rate: z.number().min(0).optional(),
  /** low: per hour (default 4). */
  perHour: z.number().min(0).optional(),
  /** rare: per day (default 3). */
  perDay: z.number().min(0).optional(),
  /** Share of the peak at night (02:00 UTC); daily default 0.3. */
  night: z.number().min(0).max(1).optional(),
  /** Share on weekends and holidays; daily default 0.4, otherwise 1. */
  weekend: z.number().min(0).max(1).optional(),
  /** Days (from start) as quiet as a weekend. */
  holidays: z.array(z.number().int().min(0)).optional(),
  /** bursty: calls per clump (default 20) and minutes between clumps on average (default 15). */
  clumpSize: z.number().min(1).optional(),
  clumpEvery: z.number().min(1).optional(),
  /** test-bursts: burst length in minutes and idle gap in hours, [min, max]. */
  burstMinutes: z.tuple([z.number().min(1), z.number().min(1)]).optional(),
  idleHours: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
  /** test-bursts: bursts at exactly these times instead of random ones (history stays random). */
  schedule: z.array(time).optional(),
});
export type Traffic = z.infer<typeof trafficSchema>;

export const outboundNormalSchema = z.object({
  /** Provider errors (5xx, a fifth of them timeouts), share of calls; varies by day ±50%. */
  errors: z.number().min(0).max(1).optional(),
  notFound: z.number().min(0).max(1).optional(),
  validation: z.number().min(0).max(1).optional(),
  /** Median latency (ms) and log-normal spread. */
  latencyMs: z.number().min(1).optional(),
  latencySigma: z.number().min(0).max(3).optional(),
  /** Everyday noise (lone 5xx, single very slow calls, short latency wobbles); default on. */
  noise: z.boolean().optional(),
});

export const inboundNormalSchema = z.object({
  /** Deliveries our app doesn't answer 2xx, share. */
  rejected: z.number().min(0).max(1).optional(),
  handlerMs: z.number().min(1).optional(),
  /** Median delivery lag (s) after the sender signs; share of deliveries 20–90 s late. */
  lagS: z.number().min(0).optional(),
  lateShare: z.number().min(0).max(1).optional(),
  /** Senders without a signed timestamp have no lag. */
  signed: z.boolean().optional(),
  noise: z.boolean().optional(),
});

export const endpointSchema = z.object({
  id: z.string().min(1).optional(),
  method: z.string().min(1).default('GET'),
  path: z.string().startsWith('/'),
  traffic: trafficSchema,
  normal: outboundNormalSchema.default({}),
});

export const providerSchema = z.object({
  name: z.string().min(1).max(64),
  host: z.string().min(1).optional(),
  endpoints: z.array(endpointSchema).min(1),
});

/**
 * A webhook source the SDK doesn't know yet (webhook discovery): each minute's deliveries
 * go through the SDK's own discovery rules (`classifyWebhookCandidate`) with this request
 * shape; a candidate is stored like one reported at ingest, and the source is monitored
 * (as `provider`) only once confirmed at `confirm` (as an admin does in the dashboard).
 */
export const discoverySchema = z.object({
  method: z.enum(['POST', 'PUT']).default('POST'),
  /** Request headers as the sender sends them (names and values: CloudEvents, signature, host). */
  headers: z.record(z.string(), z.string()).default({}),
  /** When the route is confirmed in the dashboard (absent: never; it stays a candidate). */
  confirm: time.optional(),
});

export const webhookSchema = z.object({
  id: z.string().min(1).optional(),
  provider: z.string().min(1).max(64),
  route: z.string().startsWith('/'),
  traffic: trafficSchema,
  normal: inboundNormalSchema.default({}),
  discovery: discoverySchema.optional(),
});

export const faultSchema = z.object({
  id: z.string().min(1),
  /** A source id: "PayCo POST /v1/charges", "NotifyCo webhooks /webhooks/notifyco", or its `id`. */
  target: z.string().min(1),
  at: time,
  duration: duration,
  type: z.enum([...OUTBOUND_FAULTS, ...INBOUND_FAULTS]),
  /** Share of calls for error faults and `rejected`; multiplier for latency; ms for slow; seconds for late. */
  size: z.number().min(0).optional(),
  /** latency: grow from 1× to `size` over the duration (slow degradation). */
  ramp: z.boolean().optional(),
  /** rejected: the status our app answers (default 500; 401 for a signing-secret mismatch). */
  status: z.number().int().optional(),
});

export const expectSchema = z.union([
  z.object({
    incident: z.object({
      kind: z.union([z.string(), z.array(z.string())]).optional(),
      target: z.string().optional(),
      fault: z.string(),
      within: duration,
    }),
  }),
  z.object({
    quiet: z.object({ from: time, to: time, target: z.string().optional() }),
  }),
  z.object({
    irregular: z.object({ target: z.string(), by: time }),
  }),
  z.object({
    discovered: z.object({
      /** A webhook source with `discovery`. */
      target: z.string(),
      by: time,
      /** The name the SDK should suggest. */
      name: z.string().optional(),
    }),
  }),
]);

/** The start option (no default here: an override must not fill one in). */
export const historySchema = z.union([
  z.object({ mode: z.literal('empty') }),
  z.object({
    mode: z.literal('seeded'),
    days: z.number().int().min(1).max(60),
    /** One pattern for every source's history (default: each source's own traffic). */
    traffic: trafficSchema.optional(),
  }),
]);

export const scenarioSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  /** Simulated start, default Monday 2026-01-05 00:00 UTC. */
  start: z.string().default('2026-01-05T00:00:00Z'),
  duration: duration,
  seed: z.number().int().default(1),
  environment: z.string().default('production'),
  /** Start from an empty database, or with this much history generated from the sources' own patterns. */
  history: historySchema.default({ mode: 'empty' }),
  providers: z.array(providerSchema).default([]),
  webhooks: z.array(webhookSchema).default([]),
  faults: z.array(faultSchema).default([]),
  expect: z.array(expectSchema).default([]),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export type Fault = z.infer<typeof faultSchema>;
export type Expectation = z.infer<typeof expectSchema>;

export interface OutboundSource {
  kind: 'outbound';
  id: string;
  provider: string;
  host: string;
  method: string;
  endpoint: string;
  traffic: Traffic;
  normal: z.infer<typeof outboundNormalSchema>;
}
export interface InboundSource {
  kind: 'inbound';
  id: string;
  provider: string;
  endpoint: string;
  traffic: Traffic;
  normal: z.infer<typeof inboundNormalSchema>;
  discovery?: z.infer<typeof discoverySchema>;
}
export type Source = OutboundSource | InboundSource;

export const outboundId = (provider: string, method: string, path: string) =>
  `${provider} ${method.toUpperCase()} ${path}`;
export const inboundId = (provider: string, route: string) => `${provider} webhooks ${route}`;

/** Every source of a scenario with its id (explicit, or derived). */
export function sourcesOf(s: Scenario): Source[] {
  const out: Source[] = [];
  for (const p of s.providers)
    for (const e of p.endpoints)
      out.push({
        kind: 'outbound',
        id: e.id ?? outboundId(p.name, e.method, e.path),
        provider: p.name,
        host: p.host ?? `api.${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.test`,
        method: e.method.toUpperCase(),
        endpoint: e.path,
        traffic: e.traffic,
        normal: e.normal,
      });
  for (const w of s.webhooks)
    out.push({
      kind: 'inbound',
      id: w.id ?? inboundId(w.provider, w.route),
      provider: w.provider,
      endpoint: w.route,
      traffic: w.traffic,
      normal: w.normal,
      ...(w.discovery ? { discovery: w.discovery } : {}),
    });
  return out;
}

/** Ids that refer to a source: its id and its derived name. */
function matches(src: Source, target: string): boolean {
  const derived =
    src.kind === 'outbound'
      ? outboundId(src.provider, src.method, src.endpoint)
      : inboundId(src.provider, src.endpoint);
  return target === src.id || target === derived;
}

export function findSource(s: Scenario, target: string): Source | undefined {
  return sourcesOf(s).find((src) => matches(src, target));
}

export interface ResolvedFault extends Fault {
  from: number;
  to: number;
  source: Source;
}

/** Parse and check a scenario: references resolve, fault types fit their source. */
export function validateScenario(input: unknown): {
  scenario: Scenario;
  start: number;
  end: number;
  faults: ResolvedFault[];
} {
  const scenario = scenarioSchema.parse(input);
  const start = Date.parse(scenario.start);
  if (!Number.isFinite(start)) throw new Error(`bad start "${scenario.start}"`);
  const end = start + parseDuration(scenario.duration);
  const ids = new Set<string>();
  for (const src of sourcesOf(scenario)) {
    if (ids.has(src.id)) throw new Error(`duplicate source "${src.id}"`);
    ids.add(src.id);
  }
  const faultIds = new Set<string>();
  const faults = scenario.faults.map((f) => {
    if (faultIds.has(f.id)) throw new Error(`duplicate fault id "${f.id}"`);
    faultIds.add(f.id);
    const source = findSource(scenario, f.target);
    if (!source) throw new Error(`fault "${f.id}": no source "${f.target}"`);
    const inbound = (INBOUND_FAULTS as readonly string[]).includes(f.type);
    if (inbound !== (source.kind === 'inbound'))
      throw new Error(
        `fault "${f.id}": ${f.type} is a ${inbound ? 'webhook' : 'outgoing-call'} fault, but "${f.target}" is ${source.kind === 'inbound' ? 'a webhook source' : 'an endpoint'}`,
      );
    const from = parseTime(f.at, start);
    return { ...f, from, to: from + parseDuration(f.duration), source };
  });
  for (const e of scenario.expect) {
    if ('incident' in e) {
      if (!faultIds.has(e.incident.fault))
        throw new Error(`expect: no fault "${e.incident.fault}"`);
      if (e.incident.target && !findSource(scenario, e.incident.target))
        throw new Error(`expect: no source "${e.incident.target}"`);
      parseDuration(e.incident.within);
    } else if ('quiet' in e) {
      parseTime(e.quiet.from, start);
      parseTime(e.quiet.to, start);
      if (e.quiet.target && !findSource(scenario, e.quiet.target))
        throw new Error(`expect: no source "${e.quiet.target}"`);
    } else if ('irregular' in e) {
      const src = findSource(scenario, e.irregular.target);
      if (!src || src.kind !== 'inbound')
        throw new Error(`expect: "${e.irregular.target}" is not a webhook source`);
      parseTime(e.irregular.by, start);
    } else {
      const src = findSource(scenario, e.discovered.target);
      if (!src || src.kind !== 'inbound' || !src.discovery)
        throw new Error(`expect: "${e.discovered.target}" is not a webhook source with discovery`);
      parseTime(e.discovered.by, start);
    }
  }
  for (const src of sourcesOf(scenario))
    if (src.kind === 'inbound' && src.discovery?.confirm !== undefined)
      parseTime(src.discovery.confirm, start);
  return { scenario, start, end, faults };
}

export function parseScenarioYaml(text: string) {
  return validateScenario(parseYaml(text));
}

export function scenarioToYaml(s: Scenario): string {
  return stringifyYaml(s, { lineWidth: 100 });
}
