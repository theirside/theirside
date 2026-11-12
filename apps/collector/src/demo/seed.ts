import {
  bucketIndex,
  emptyHistogram,
  EndpointTemplater,
  OUTCOMES,
  type Outcome,
} from '@theirside/shared';
import { addDelivery } from '../modules/ingest/prepare.js';
import { refreshBaselines } from '../modules/scoring/baseline.js';
import { refreshInboundBaselines } from '../modules/scoring/inbound.js';
import { resolveThresholds } from '../modules/scoring/thresholds.js';
import type {
  InboundRollupRow,
  Incident,
  RollupDelta,
  RollupKey,
  StoredEvent,
  Storage,
  Tenant,
} from '../storage/types.js';
import { newId } from '../util/ids.js';
import { inboundKeyId } from '../storage/types.js';

/**
 * Demo data (docs/demo.md): 7 days of synthetic rollups for the four fake
 * providers of the demo stack, a few raw failure events for request-ID
 * samples, past incidents over 30 days (status page history) and fresh
 * baselines, so the demo dashboard looks like an install that has been
 * running for a week. Goes through the storage interfaces like everything else.
 *
 * Refuses to touch anything that does not look like an empty demo install;
 * see checkDemoDatabase. A second run is a no-op.
 */

export const DEMO_ENVIRONMENT = 'demo';
const SEEDED_META_KEY = 'demo_seeded_at';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HISTORY_DAYS = 30;

interface EndpointProfile {
  method: string;
  /** Host the demo app calls for this endpoint (with port). */
  host: string;
  /** Raw path shape as the demo sends it; templated like the SDK does. */
  rawPath: string;
  /** Calls per minute at the daily peak. */
  peakPerMin: number;
  /** Normal provider-error rate (5xx, timeouts, resets). */
  errorRate: number;
  /** Client errors (4xx), not provider errors. */
  clientErrorRate: number;
  /** Median latency, ms. */
  medianMs: number;
}

interface ProviderProfile {
  /** The name the collector gives the provider: registrable domain, or catalog name. */
  name: string;
  source: 'discovered' | 'catalog';
  category: string;
  domain: string;
  hosts: string[];
  hostPatterns: string[];
  supportEmail: string;
  supportUrl: string;
  publicDisplayName: string;
  isPublic: boolean;
  endpoints: EndpointProfile[];
}

/**
 * Mirrors the zero-config demo (examples/nestjs-demo, docker network aliases):
 * names as auto-discovery assigns them; contacts as tools/loadgen/src/setup.ts sets them.
 */
export const DEMO_PROVIDERS: ProviderProfile[] = [
  {
    name: 'acmecards.test',
    source: 'discovered',
    category: 'other',
    domain: 'acmecards.test',
    hosts: ['api.acmecards.test:4010', 'files.acmecards.test:4010', 'sandbox.acmecards.test:4010'],
    hostPatterns: [],
    supportEmail: 'support@acmecards.test',
    supportUrl: 'https://status.acmecards.test',
    publicDisplayName: 'Card issuing',
    isPublic: true,
    endpoints: [
      {
        method: 'POST',
        host: 'api.acmecards.test:4010',
        rawPath: '/v2/cards/card_4Hx9aQ2mZ/activate',
        peakPerMin: 14,
        errorRate: 0.002,
        clientErrorRate: 0.01,
        medianMs: 180,
      },
      {
        method: 'GET',
        host: 'api.acmecards.test:4010',
        rawPath: '/v2/cards/card_7Kp2sW9xL',
        peakPerMin: 20,
        errorRate: 0.0005,
        clientErrorRate: 0.004,
        medianMs: 90,
      },
      {
        method: 'POST',
        host: 'api.acmecards.test:4010',
        rawPath: '/v2/cards',
        peakPerMin: 6,
        errorRate: 0.003,
        clientErrorRate: 0.02,
        medianMs: 240,
      },
      {
        method: 'GET',
        host: 'files.acmecards.test:4010',
        rawPath: '/v1/files/card_7Kp2sW9xL',
        peakPerMin: 12,
        errorRate: 0.001,
        clientErrorRate: 0.002,
        medianMs: 140,
      },
    ],
  },
  {
    name: 'kyco.test',
    source: 'discovered',
    category: 'other',
    domain: 'kyco.test',
    hosts: ['api.kyco.test:4010'],
    hostPatterns: [],
    supportEmail: 'help@kyco.test',
    supportUrl: 'https://kyco.test/support',
    publicDisplayName: 'Identity checks',
    isPublic: true,
    // the noisy one: ~3% provider errors is its normal
    endpoints: [
      {
        method: 'POST',
        host: 'api.kyco.test:4010',
        rawPath: '/v1/kyc/checks',
        peakPerMin: 8,
        errorRate: 0.03,
        clientErrorRate: 0.01,
        medianMs: 850,
      },
    ],
  },
  {
    name: 'bankco.test',
    source: 'discovered',
    category: 'other',
    domain: 'bankco.test',
    hosts: ['api.bankco.test:4010'],
    hostPatterns: [],
    supportEmail: 'api-support@bankco.test',
    supportUrl: 'https://bankco.test/dev',
    publicDisplayName: 'Payouts',
    isPublic: true,
    endpoints: [
      {
        method: 'POST',
        host: 'api.bankco.test:4010',
        rawPath: '/v1/transfers',
        peakPerMin: 5,
        errorRate: 0.005,
        clientErrorRate: 0.01,
        medianMs: 420,
      },
      {
        method: 'GET',
        host: 'api.bankco.test:4010',
        rawPath: '/v1/accounts/acc_3Fh8kL2pQ/balance',
        peakPerMin: 9,
        errorRate: 0.001,
        clientErrorRate: 0.002,
        medianMs: 120,
      },
    ],
  },
  {
    // named by the demo catalog override (apps/collector/demo-catalog.json)
    name: 'NotifyCo',
    source: 'catalog',
    category: 'messaging',
    domain: 'notifyco.test',
    hosts: ['api.notifyco.test:4010'],
    hostPatterns: [],
    supportEmail: 'support@notifyco.test',
    supportUrl: 'https://notifyco.test',
    publicDisplayName: 'Notifications',
    isPublic: false,
    endpoints: [
      {
        method: 'POST',
        host: 'api.notifyco.test:4010',
        rawPath: '/v1/messages',
        peakPerMin: 12,
        errorRate: 0.0001,
        clientErrorRate: 0.001,
        medianMs: 60,
      },
    ],
  },
  {
    // one subdomain per customer: already folded into *.saasco.test
    name: 'saasco.test',
    source: 'discovered',
    category: 'other',
    domain: 'saasco.test',
    hosts: [],
    hostPatterns: ['*.saasco.test'],
    supportEmail: 'support@saasco.test',
    supportUrl: 'https://saasco.test/help',
    publicDisplayName: 'Workspace sync',
    isPublic: false,
    endpoints: [
      {
        method: 'GET',
        host: 't17.saasco.test:4010',
        rawPath: '/v1/workspace/sync',
        peakPerMin: 7,
        errorRate: 0.004,
        clientErrorRate: 0.003,
        medianMs: 300,
      },
    ],
  },
];

/** Past incidents, by days/hours ago. Those in the last 7 days also shape the rollups. */
interface PastIncident {
  provider: string;
  /** Index into the provider's endpoints. */
  endpoints: number[];
  kind: 'errors' | 'latency';
  startedAgoMin: number;
  durationMin: number;
  errorRate: number;
  latencyFactor: number;
  outcome: Outcome;
}

const PAST_INCIDENTS: PastIncident[] = [
  {
    provider: 'acmecards.test',
    endpoints: [0],
    kind: 'errors',
    startedAgoMin: 2 * 1440 + 9 * 60,
    durationMin: 24,
    errorRate: 0.38,
    latencyFactor: 6,
    outcome: 'http_5xx',
  },
  {
    provider: 'kyco.test',
    endpoints: [0],
    kind: 'errors',
    startedAgoMin: 4 * 1440 + 3 * 60,
    durationMin: 41,
    errorRate: 0.27,
    latencyFactor: 3,
    outcome: 'timeout',
  },
  {
    provider: 'bankco.test',
    endpoints: [0],
    kind: 'latency',
    startedAgoMin: 5 * 1440 + 14 * 60,
    durationMin: 33,
    errorRate: 0.01,
    latencyFactor: 9,
    outcome: 'timeout',
  },
  {
    provider: 'acmecards.test',
    endpoints: [0, 1],
    kind: 'errors',
    startedAgoMin: 11 * 1440 + 16 * 60,
    durationMin: 52,
    errorRate: 0.61,
    latencyFactor: 4,
    outcome: 'conn_reset',
  },
  {
    provider: 'NotifyCo',
    endpoints: [0],
    kind: 'errors',
    startedAgoMin: 18 * 1440 + 7 * 60,
    durationMin: 95,
    errorRate: 0.9,
    latencyFactor: 2,
    outcome: 'conn_refused',
  },
  {
    provider: 'kyco.test',
    endpoints: [0],
    kind: 'errors',
    startedAgoMin: 26 * 1440 + 12 * 60,
    durationMin: 18,
    errorRate: 0.22,
    latencyFactor: 2,
    outcome: 'http_5xx',
  },
];

/** Deterministic PRNG (mulberry32): the same seed gives the same week. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Busy during European/US business hours (UTC), quiet at night and at weekends. */
function trafficFactor(t: Date): number {
  const h = t.getUTCHours() + t.getUTCMinutes() / 60;
  const day = 0.15 + 0.85 * Math.exp(-((h - 13.5) ** 2) / (2 * 3.5 ** 2));
  const wd = t.getUTCDay();
  return day * (wd === 0 || wd === 6 ? 0.55 : 1);
}

function poisson(rand: () => number, mean: number): number {
  if (mean <= 0) return 0;
  if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * gaussian(rand)));
  const l = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l);
  return k - 1;
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
}

const emptyOutcomes = () =>
  Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;

export class DemoSeedRefused extends Error {}

/** Throws DemoSeedRefused unless this looks like a fresh demo install. Returns false if already seeded. */
export async function checkDemoDatabase(storage: Storage, now: Date): Promise<Tenant | null> {
  if (await storage.config.getMeta(SEEDED_META_KEY)) return null;
  const orgs = await storage.config.listOrgs();
  if (orgs.length !== 1)
    throw new DemoSeedRefused(
      `expected exactly one org (the bootstrap one), found ${orgs.length}; start the demo stack first`,
    );
  const projects = await storage.config.listProjects(orgs[0]!.id);
  if (projects.length !== 1)
    throw new DemoSeedRefused(`expected exactly one project, found ${projects.length}`);
  const tenant = { orgId: orgs[0]!.id, projectId: projects[0]!.id };
  const demoNames = new Set(DEMO_PROVIDERS.map((p) => p.name));
  const foreign = (await storage.config.listProviders(tenant)).filter(
    (p) => !demoNames.has(p.name),
  );
  if (foreign.length > 0)
    throw new DemoSeedRefused(
      `database has non-demo providers (${foreign.map((p) => p.name).join(', ')}); the demo seed only runs on a demo install`,
    );
  const old = await storage.rollups.aggregateByKey(tenant, {
    from: new Date(0),
    to: new Date(now.getTime() - 2 * 60 * MIN),
  });
  if (old.length > 0)
    throw new DemoSeedRefused(
      'database already has data older than 2 hours; not a fresh demo install',
    );
  return tenant;
}

export interface SeedResult {
  seeded: boolean;
  rollupRows: number;
  calls: number;
  events: number;
  incidents: number;
  baselines: number;
}

export async function seedDemo(
  storage: Storage,
  opts: { now?: Date; days?: number; seed?: number; log?: (m: string) => void } = {},
): Promise<SeedResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const rand = rng(opts.seed ?? 20261104);
  const tenant = await checkDemoDatabase(storage, now);
  if (!tenant) {
    log('demo data already seeded; nothing to do');
    return { seeded: false, rollupRows: 0, calls: 0, events: 0, incidents: 0, baselines: 0 };
  }

  // the demo's own templating, so seeded keys line up with live traffic
  const templater = new EndpointTemplater();
  for (const p of DEMO_PROVIDERS) {
    await storage.config.upsertProvider(tenant, {
      name: p.name,
      hostPatterns: p.hostPatterns,
      explicitRoutes: [],
      supportEmail: p.supportEmail,
      supportUrl: p.supportUrl,
      supportNotes: null,
      publicDisplayName: p.publicDisplayName,
      isPublic: p.isPublic,
      source: p.source,
      category: p.category,
      domain: p.domain,
      hosts: p.hosts,
      // established a month ago, like the history below: not "New", no digest
      firstSeenAt: new Date(now.getTime() - HISTORY_DAYS * DAY),
    });
  }
  const keys = DEMO_PROVIDERS.flatMap((p) =>
    p.endpoints.map((e) => ({
      provider: p,
      profile: e,
      key: {
        environment: DEMO_ENVIRONMENT,
        provider: p.name,
        method: e.method,
        endpoint: templater.template(e.host, e.rawPath),
      } satisfies RollupKey,
    })),
  );

  const end = new Date(Math.floor(now.getTime() / MIN) * MIN); // current minute: live traffic
  const start = new Date(end.getTime() - days * DAY);
  // older history (status page: 30 days) at one row per hour: cheap, and only
  // daily totals and incidents are read that far back
  const historyStart = new Date(end.getTime() - HISTORY_DAYS * DAY);
  await storage.events.ensurePartitions(start, days + 2);

  const incidentAt = (provider: string, endpointIdx: number, t: number) =>
    PAST_INCIDENTS.find((i) => {
      if (i.provider !== provider || !i.endpoints.includes(endpointIdx)) return false;
      const from = end.getTime() - i.startedAgoMin * MIN;
      return t >= from && t < from + i.durationMin * MIN;
    });

  let rollupRows = 0;
  let calls = 0;
  let events = 0;
  let batch: RollupDelta[] = [];
  const lastCalls = new Map<string, Date>();
  const flush = async () => {
    if (batch.length === 0) return;
    await storage.rollups.upsert(tenant, batch);
    rollupRows += batch.length;
    batch = [];
  };

  for (let t = historyStart.getTime(); t < end.getTime();) {
    const minute = new Date(t);
    const step = t < start.getTime() ? 60 : 1; // minutes this row stands for
    t += step * MIN;
    const factor = trafficFactor(minute) * step;
    for (const { provider, profile, key } of keys) {
      const idx = provider.endpoints.indexOf(profile);
      const total = poisson(rand, profile.peakPerMin * factor);
      if (total === 0) continue;
      const inc = incidentAt(provider.name, idx, minute.getTime());
      const errRate = inc ? inc.errorRate : profile.errorRate;
      const latency = inc ? inc.latencyFactor : 1;
      const outcomes = emptyOutcomes();
      const hist = emptyHistogram();
      let sum = 0;
      let failed: number[] = [];
      for (let i = 0; i < total; i++) {
        const r = rand();
        let outcome: Outcome;
        if (r < errRate) {
          outcome = inc
            ? inc.outcome
            : (['http_5xx', 'http_5xx', 'http_5xx', 'timeout', 'conn_reset'] as const)[
                Math.floor(rand() * 5)
              ]!;
          failed.push(i);
        } else if (r < errRate + profile.clientErrorRate) outcome = 'http_4xx';
        else outcome = 'ok';
        outcomes[outcome]++;
        const ms =
          outcome === 'timeout'
            ? 10_000
            : profile.medianMs * latency * Math.exp(0.45 * gaussian(rand));
        hist[bucketIndex(ms)]!++;
        sum += ms;
      }
      calls += total;
      lastCalls.set(provider.name, minute);
      batch.push({
        ...key,
        minute: minute.toISOString(),
        total,
        ok: outcomes.ok,
        outcomes,
        status429: 0,
        latencyHistogram: hist,
        latencySumMs: Math.round(sum),
      });
      // a few raw failure events per incident minute, so incidents have request-ID samples
      if (inc && failed.length > 0 && step === 1) {
        failed = failed.slice(0, 2);
        const raw: StoredEvent[] = failed.map((i) => ({
          ts: new Date(minute.getTime() + i * 1000),
          service: 'nestjs-demo',
          environment: DEMO_ENVIRONMENT,
          sdkVersion: 'demo-seed',
          provider: provider.name,
          host: profile.host,
          method: key.method,
          endpoint: key.endpoint,
          status: inc.outcome === 'http_5xx' ? 503 : null,
          durationMs: Math.round(profile.medianMs * inc.latencyFactor),
          outcome: inc.outcome,
          errorCode:
            inc.outcome === 'timeout'
              ? 'ETIMEDOUT'
              : inc.outcome === 'conn_reset'
                ? 'ECONNRESET'
                : null,
          correlationId: null,
          providerRequestId: `req_${Math.floor(rand() * 2 ** 32)
            .toString(16)
            .padStart(8, '0')}`,
        }));
        await storage.events.insert(tenant, raw[0]!.ts, raw);
        events += raw.length;
      }
    }
    if (batch.length >= 2000) await flush();
  }
  await flush();
  await storage.config.touchProviders(tenant, lastCalls);
  log(
    `rollups: ${rollupRows} rows, ${calls} calls (${days} days per minute, ${HISTORY_DAYS} days in total)`,
  );

  const deliveries = await seedWebhooks(storage, tenant, end, rand);
  log(`webhooks: ${deliveries} NotifyCo deliveries over ${WEBHOOK_HISTORY_DAYS} days`);

  const incidents = await seedIncidents(storage, tenant, keys, end, rand);
  log(`incidents: ${incidents} over 30 days`);

  const t = resolveThresholds(await storage.config.getThresholds(tenant));
  const baselines = await refreshBaselines(
    storage,
    tenant,
    keys.map((k) => k.key),
    end,
    t,
  );
  log(`baselines: ${baselines.size} computed`);

  await storage.config.setMetaIfAbsent(SEEDED_META_KEY, end.toISOString());
  return { seeded: true, rollupRows, calls, events, incidents, baselines: baselines.size };
}

/** Inbound history: a day more than silence needs (silenceMinHistoryDays), so it is judged at once. */
export const WEBHOOK_HISTORY_DAYS = 22;
/** The chaos provider's default rate (WEBHOOK_RATE_PER_MIN), so live traffic matches the history. */
const WEBHOOKS_PER_MIN = 30;
export const DEMO_WEBHOOK_ROUTE = '/webhooks/notifyco';

/**
 * NotifyCo's webhooks to the demo app, per minute (docs/demo.md): steady
 * deliveries, accepted, handled in ~15 ms and signed ~1 s before arrival,
 * written as inbound rollups, the source row and its baseline (silence profile).
 */
async function seedWebhooks(
  storage: Storage,
  tenant: Tenant,
  end: Date,
  rand: () => number,
): Promise<number> {
  const key = { environment: DEMO_ENVIRONMENT, provider: 'NotifyCo', endpoint: DEMO_WEBHOOK_ROUTE };
  const rows: InboundRollupRow[] = [];
  let total = 0;
  for (let t = end.getTime() - WEBHOOK_HISTORY_DAYS * DAY; t < end.getTime(); t += MIN) {
    const n = poisson(rand, WEBHOOKS_PER_MIN);
    if (n === 0) continue;
    const r: InboundRollupRow = {
      ...key,
      minute: new Date(t).toISOString(),
      total: 0,
      accepted: 0,
      rejected: 0,
      status3xx: 0,
      status401: 0,
      status403: 0,
      status4xx: 0,
      status5xx: 0,
      unanswered: 0,
      durationHistogram: emptyHistogram(),
      durationSumMs: 0,
      lagCount: 0,
      lagSumS: 0,
      lagHistogram: emptyHistogram(),
    };
    for (let i = 0; i < n; i++)
      addDelivery(
        r,
        200,
        15 * Math.exp(0.4 * gaussian(rand)),
        1000 * Math.exp(0.3 * gaussian(rand)),
      );
    rows.push(r);
    total += n;
    if (rows.length >= 2000) await storage.inbound.upsertRollups(tenant, rows.splice(0));
  }
  await storage.inbound.upsertRollups(tenant, rows);
  await storage.inbound.touchSources(tenant, [
    { ...key, lastDeliveryAt: end, service: 'nestjs-demo' },
  ]);
  const t = resolveThresholds(await storage.config.getThresholds(tenant));
  await refreshInboundBaselines(
    storage,
    tenant,
    [key],
    new Map([[inboundKeyId(key), end]]),
    end,
    t,
  );
  return total;
}

const hhmm = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;
const pctText = (x: number) => `${Math.round(x * 100)}%`;
const msText = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);

async function seedIncidents(
  storage: Storage,
  tenant: Tenant,
  keys: { provider: ProviderProfile; profile: EndpointProfile; key: RollupKey }[],
  end: Date,
  rand: () => number,
): Promise<number> {
  for (const pi of PAST_INCIDENTS) {
    const provider = DEMO_PROVIDERS.find((p) => p.name === pi.provider)!;
    const eps = pi.endpoints.map((i) =>
      keys.find((k) => k.provider === provider && k.profile === provider.endpoints[i])!,
    );
    const openedAt = new Date(end.getTime() - pi.startedAgoMin * MIN);
    const resolvedAt = new Date(openedAt.getTime() + (pi.durationMin + 14) * MIN); // resolve lands ~14 min after recovery
    const peakP95 = Math.max(...eps.map((e) => e.profile.medianMs * pi.latencyFactor * 2.1));
    const what =
      eps.length === 1
        ? `${eps[0]!.key.method} ${eps[0]!.key.endpoint}`
        : `${eps.length} endpoints`;
    const verb = pi.kind === 'latency' ? 'slow' : 'failing';
    const ids = Array.from(
      { length: 3 },
      () =>
        `req_${Math.floor(rand() * 2 ** 32)
          .toString(16)
          .padStart(8, '0')}`,
    );
    const summary = [
      `${pi.provider} — ${what} recovered at ${hhmm(resolvedAt)} after ${pi.durationMin + 14} min (${verb} since ${hhmm(openedAt)})`,
      `Peak error rate ${pctText(pi.errorRate)}, peak p95 latency ${msText(peakP95)}.`,
      `Sample provider request IDs: ${ids.join(', ')}`,
      `Support: ${[provider.supportEmail, provider.supportUrl].filter(Boolean).join(', ')}`,
    ].join('\n');
    const inc: Incident = {
      ...tenant,
      id: newId('inc'),
      environment: DEMO_ENVIRONMENT,
      provider: pi.provider,
      scope: eps.length > 1 ? 'provider' : 'endpoint',
      kind: pi.kind,
      status: 'resolved',
      openedAt,
      resolvedAt,
      lastAlertedRate: pi.errorRate,
      lastAlertedP95Ms: Math.round(peakP95),
      lastEvaluatedMinute: resolvedAt,
      alertsMuted: false,
      windowMinutes: 5,
      peakErrorRate: pi.errorRate,
      peakP95Ms: Math.round(peakP95),
      baseline: {},
      summary,
      sampleRequestIds: ids,
      endpoints: eps.map((e) => ({
        endpoint: e.key.endpoint,
        method: e.key.method,
        firstSeenAt: openedAt,
        recoveredAt: new Date(openedAt.getTime() + pi.durationMin * MIN),
        peakErrorRate: pi.errorRate,
      })),
    };
    await storage.incidents.create(inc);
  }
  return PAST_INCIDENTS.length;
}
