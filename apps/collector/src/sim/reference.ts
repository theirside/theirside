/**
 * The scenario reference: every setting a simulation scenario has, what it does and its
 * default. One source for the Simulation page (`GET /__sim/reference`: field hints and the
 * Reference panel), `pnpm sim:help [topic]` and docs/simulation-reference.md (generated:
 * `pnpm sim:help --write`). test/sim-reference.test.ts fails when a scenario setting has
 * no entry here or the generated page is out of date. Defaults come from the generators.
 */
import { INCIDENT_KINDS } from '../modules/scoring/evaluate.js';
import { INBOUND_KINDS } from '../storage/types.js';
import {
  FAULT_DEFAULT_SIZE,
  INBOUND_NORMAL_DEFAULTS as IN,
  OUTBOUND_NORMAL_DEFAULTS as OUT,
  TRAFFIC_DEFAULTS as T,
} from './generate.js';
import { INBOUND_FAULTS, OUTBOUND_FAULTS, PATTERNS } from './scenario.js';

export interface RefEntry {
  /** The YAML key or value ("rate", "daily", "5xx", "day N HH:MM"). */
  key: string;
  /** One line: shown as the field hint and in lists. */
  summary: string;
  /** More, when one line isn't enough. */
  detail?: string;
  default?: string;
  /** Patterns: the traffic settings it uses. Fault types: outgoing or webhook. */
  uses?: string[];
  /** A short YAML example. */
  example?: string;
}

export interface RefSection {
  id: string;
  title: string;
  intro?: string;
  entries: RefEntry[];
}

const pct = (x: number) => `${+(x * 100).toFixed(2)}%`;
const range = ([a, b]: [number, number]) => `${a}–${b}`;

const PATTERN_ENTRIES: Record<(typeof PATTERNS)[number], Omit<RefEntry, 'key'>> = {
  steady: {
    summary: 'The same rate around the clock.',
    detail: 'Flat unless `night` or `weekend` is set.',
    uses: ['rate', 'night', 'weekend', 'holidays'],
    example: 'traffic: { pattern: steady, rate: 30 }',
  },
  daily: {
    summary: 'A daily cycle: peak at 14:00 UTC, lowest at 02:00 UTC, quieter at weekends.',
    detail: `\`rate\` is the 14:00 peak, so the average is lower: with the defaults about 65% of the peak on weekdays and 26% at weekends.`,
    uses: ['rate', 'night', 'weekend', 'holidays'],
    example: 'traffic: { pattern: daily, rate: 40, night: 0.2, weekend: 0.3, holidays: [9] }',
  },
  low: {
    summary: 'A few calls an hour, flat.',
    uses: ['perHour', 'night', 'weekend', 'holidays'],
    example: 'traffic: { pattern: low, perHour: 6 }',
  },
  rare: {
    summary: 'A few calls a day; whole hours often pass without one.',
    detail:
      'Exercises the guards for sparse traffic: no silence or error alarms on a handful of calls.',
    uses: ['perDay', 'night', 'weekend', 'holidays'],
    example: 'traffic: { pattern: rare, perDay: 5 }',
  },
  bursty: {
    summary: 'Clumps of calls with long gaps between them, on a daily cycle.',
    detail:
      'Like a sender that batches webhooks: 80% of the traffic comes in clumps (each spread over 1–3 minutes), 20% as background. Silence must wait for its longest normal gap.',
    uses: ['clumpSize', 'clumpEvery', 'rate', 'night', 'weekend', 'holidays'],
    example: 'traffic: { pattern: bursty, clumpSize: 20, clumpEvery: 15 }',
  },
  'test-bursts': {
    summary: 'Traffic only in bursts, nothing in between (a dev or test environment).',
    detail:
      'Random bursts, or exactly at `schedule` times (then none after the last one). Seeded history always uses random bursts.',
    uses: ['rate', 'burstMinutes', 'idleHours', 'schedule'],
    example:
      'traffic: { pattern: test-bursts, rate: 5, burstMinutes: [60, 90], schedule: ["day 1 15:00"] }',
  },
  off: {
    summary: 'No traffic.',
    uses: [],
    example: 'traffic: { pattern: off }',
  },
};

const FAULT_ENTRIES: Record<
  (typeof OUTBOUND_FAULTS)[number] | (typeof INBOUND_FAULTS)[number],
  Omit<RefEntry, 'key' | 'default' | 'uses'>
> = {
  '5xx': {
    summary: '`size` share of calls answer 503 (an outage or partial outage); incident `errors`.',
  },
  timeouts: { summary: '`size` share of calls time out after 10–30 s; incident `errors`.' },
  resets: { summary: '`size` share of calls fail with a connection reset; incident `errors`.' },
  auth: {
    summary:
      '`size` share of calls answer 401/403 (changed access rules, a revoked key); incident `auth`.',
  },
  not_found: { summary: '`size` share of calls answer 404; incident `not_found`.' },
  validation: {
    summary:
      '`size` share of calls answer 422 (or `status`, e.g. 400), never tagged expected; incident `validation`.',
  },
  latency: {
    summary:
      'Every call takes `size` × longer; with `ramp`, grows from 1× to `size` over the duration; incident `latency`.',
  },
  silent: { summary: 'The sender stops delivering; incident `webhook_silence`.' },
  rejected: {
    summary:
      '`size` share of deliveries get `status` from our app (500, or 401 for a signing-secret mismatch); incident `webhook_rejections`.',
  },
  slow: {
    summary: 'Our handler gets slow: median handling time `size`/2 ms; incident `webhook_slow`.',
  },
  late: {
    summary:
      'Deliveries arrive `size` seconds (median) after the sender signed them; incident `webhook_lag`.',
  },
};

const sizeUnit = (t: string) =>
  t === 'latency' ? '×' : t === 'slow' ? ' ms' : t === 'late' ? ' s' : '';
const faultDefault = (t: string) => {
  const v = FAULT_DEFAULT_SIZE[t];
  if (v === undefined) return undefined;
  return sizeUnit(t) ? `${v}${sizeUnit(t)}` : pct(v);
};

const KIND_ENTRIES: Record<string, string> = {
  errors: '5xx, timeouts or connection resets above normal.',
  auth: '401/403 above normal.',
  not_found: '404 above normal.',
  validation: '422 and other 4xx above normal.',
  rate_limited: '429 above normal.',
  behaviour: 'The status mix changed in a way none of the other kinds describe.',
  latency: 'Slower than normal.',
  webhook_silence: 'A webhook sender stopped delivering.',
  webhook_rejections: 'Our app rejects deliveries (non-2xx).',
  webhook_slow: 'Our app handles deliveries slowly.',
  webhook_lag: 'Deliveries arrive long after the sender signed them.',
};

export const REFERENCE: RefSection[] = [
  {
    id: 'scenario',
    title: 'Scenario',
    intro:
      'A YAML file in examples/sim/ (or saved from the Simulation page); the page and `pnpm sim:run` read the same format.',
    entries: [
      { key: 'name', summary: 'Shown on the page and in the CLI output.' },
      { key: 'description', summary: 'What the scenario shows and what must happen.' },
      {
        key: 'start',
        summary: 'Simulated start time (ISO, UTC). Days in times count from here.',
        default: '2026-01-05T00:00:00Z (a Monday)',
      },
      {
        key: 'duration',
        summary: 'How long the scenario runs, e.g. 3d, 2w.',
        example: 'duration: 5d',
      },
      {
        key: 'seed',
        summary: 'Random seed: the same seed gives the same traffic, run after run.',
        default: '1',
      },
      {
        key: 'environment',
        summary: 'The environment name the traffic is reported under.',
        default: 'production',
      },
      {
        key: 'history',
        summary: 'Start from an empty database, or with days of generated history (see History).',
        default: 'empty',
      },
      {
        key: 'providers',
        summary: 'Outgoing calls: providers and their endpoints (see Providers).',
      },
      { key: 'webhooks', summary: 'Incoming webhooks: senders and routes (see Webhooks).' },
      { key: 'faults', summary: 'What breaks, when and for how long (see Faults).' },
      {
        key: 'expect',
        summary: 'What must (or must not) happen; checked live (see Expectations).',
      },
    ],
  },
  {
    id: 'times',
    title: 'Times and durations',
    entries: [
      {
        key: 'day N HH:MM',
        summary: 'N days and HH:MM after `start` (with a midnight start, the clock time on day N).',
        example: 'at: day 2 14:00',
      },
      { key: '+DURATION', summary: 'That long after `start`.', example: 'at: +2d6h' },
      { key: 'ISO time', summary: 'An absolute time.', example: 'at: 2026-01-07T14:00:00Z' },
      {
        key: 'durations',
        summary: 'w, d, h, m (and s), combined: 30m, 2h, 3d, 1w2d, 1d6h.',
        example: 'duration: 1d6h',
      },
    ],
  },
  {
    id: 'history',
    title: 'History',
    intro:
      'Baselines need history: with an empty start the collector learns for about a day before it judges an endpoint, and silence needs 21 days.',
    entries: [
      { key: 'mode: empty', summary: 'Start with nothing; watch baselines form.' },
      {
        key: 'mode: seeded',
        summary: 'Generate `days` of history before the start (1–60).',
        example: 'history: { mode: seeded, days: 8 }',
      },
      {
        key: 'days',
        summary: 'Days of history to generate (seeded only).',
      },
      {
        key: 'traffic',
        summary: "One traffic pattern for every source's history (seeded only).",
        default: "each source's own traffic (random bursts instead of a schedule)",
      },
    ],
  },
  {
    id: 'providers',
    title: 'Providers and endpoints',
    entries: [
      { key: 'name', summary: 'Provider name (use fake ones: PayCo, NotifyCo, …).' },
      {
        key: 'host',
        summary: 'Its API host.',
        default: 'api.<name>.test',
      },
      { key: 'endpoints', summary: 'Its endpoints, one or more.' },
      {
        key: 'id',
        summary: 'Endpoint id for faults and expectations.',
        default: '"<provider> <METHOD> <path>", e.g. "PayCo POST /v1/charges"',
      },
      { key: 'method', summary: 'HTTP method.', default: 'GET' },
      { key: 'path', summary: 'Path template, e.g. /v1/charges/:id.' },
      { key: 'traffic', summary: 'How many calls, when (see Traffic patterns).' },
      { key: 'normal', summary: 'Normal error and latency levels (see Normal levels, outgoing).' },
      {
        key: 'markedExpected',
        summary:
          'Statuses marked expected for this endpoint from the dashboard (400, 401, 403, 404, 409, 422): counted as successful, with the safety net. Pair with `normal.expected` and `expectedTagged: false`.',
        example: 'markedExpected: [400]',
      },
    ],
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    entries: [
      { key: 'provider', summary: 'The sender, e.g. NotifyCo.' },
      { key: 'route', summary: 'Our route that receives them, e.g. /webhooks/notifyco.' },
      {
        key: 'id',
        summary: 'Source id for faults and expectations.',
        default: '"<provider> webhooks <route>"',
      },
      { key: 'traffic', summary: 'How many deliveries, when (see Traffic patterns).' },
      {
        key: 'normal',
        summary: 'Normal rejection, handling and lag levels (see Normal levels, webhooks).',
      },
      {
        key: 'discovery',
        summary:
          'A sender the SDK does not know yet: its deliveries go through the SDK’s webhook discovery rules with this request shape and become a candidate route; the source is monitored (as `provider`) only from `confirm`, as when an admin confirms the route in the dashboard.',
        detail:
          '`method` (POST or PUT), `headers` (as the sender sends them: CloudEvents `ce-*`, signature headers, `host`), `confirm` (a time; absent: it stays a candidate). The candidate route is the `route` as written.',
        example:
          "discovery:\n  headers: { ce-specversion: '1.0', ce-source: com.orbitpay, x-hmac-signature-sha-256: x }\n  confirm: day 1 10:00",
      },
    ],
  },
  {
    id: 'patterns',
    title: 'Traffic patterns',
    intro:
      'How many calls (or deliveries) a source gets each minute. Counts are random around the rate (Poisson), never exact. Times are UTC.',
    entries: PATTERNS.map((p) => ({ key: p, ...PATTERN_ENTRIES[p] })),
  },
  {
    id: 'traffic',
    title: 'Traffic settings',
    entries: [
      {
        key: 'rate',
        summary:
          'Per minute: flat (steady), at the 14:00 peak (daily), during a burst (test-bursts), on average (bursty).',
        default: `${T.rate}; test-bursts ${T.testBurstRate}; bursty clumpSize ÷ clumpEvery + 0.4`,
      },
      { key: 'perHour', summary: 'low: calls per hour.', default: String(T.perHour) },
      { key: 'perDay', summary: 'rare: calls per day.', default: String(T.perDay) },
      {
        key: 'night',
        summary: 'Level at 02:00 UTC as a share of the peak (0–1).',
        default: `${T.night} for daily and bursty; 1 (flat) for the others`,
      },
      {
        key: 'weekend',
        summary: 'Level on Saturdays, Sundays and holidays as a share (0–1).',
        default: `${T.weekend} for daily and bursty; 1 for the others`,
      },
      {
        key: 'holidays',
        summary: 'Days counted from `start` that are as quiet as a weekend.',
        example: 'holidays: [9]',
      },
      {
        key: 'clumpSize',
        summary: 'bursty: calls per clump, on average.',
        default: String(T.clumpSize),
      },
      {
        key: 'clumpEvery',
        summary: 'bursty: minutes between clumps, on average.',
        default: String(T.clumpEvery),
      },
      {
        key: 'burstMinutes',
        summary: 'test-bursts: burst length range in minutes [min, max].',
        default: range(T.burstMinutes),
      },
      {
        key: 'idleHours',
        summary: 'test-bursts: gap between random bursts in hours [min, max].',
        default: range(T.idleHours),
      },
      {
        key: 'schedule',
        summary: 'test-bursts: bursts exactly at these times instead of random ones.',
        example: 'schedule: ["day 1 15:00", "day 3 10:00"]',
      },
    ],
  },
  {
    id: 'normal-outbound',
    title: 'Normal levels, outgoing',
    intro: "An endpoint's everyday behaviour, before any fault.",
    entries: [
      {
        key: 'errors',
        summary:
          'Provider errors as a share of calls (5xx, a fifth of them timeouts); varies ±50% by day.',
        default: pct(OUT.errors),
      },
      { key: 'notFound', summary: '404s as a share of calls.', default: pct(OUT.notFound) },
      { key: 'validation', summary: '422s as a share of calls.', default: pct(OUT.validation) },
      { key: 'latencyMs', summary: 'Median latency in ms.', default: `${OUT.latencyMs} ms` },
      {
        key: 'latencySigma',
        summary: 'Latency spread (log-normal sigma, 0–3): higher means a longer slow tail.',
        default: String(OUT.latencySigma),
      },
      {
        key: 'noise',
        summary:
          'Everyday noise: a lone 5xx and a few very slow calls a day, short latency wobbles.',
        default: 'on',
      },
      {
        key: 'expected',
        summary:
          'Expected outcomes: a share of calls answered with a 4xx that is a normal business answer (a consent check answering 400 when the user has not consented). A number, or `[min, max]`: the share drifts between them hour by hour.',
        default: 'none',
        example: 'expected: [0.1, 0.4]',
      },
      {
        key: 'expectedStatus',
        summary: 'The status of those answers (a 4xx).',
        default: String(OUT.expectedStatus),
      },
      {
        key: 'expectedTagged',
        summary:
          'Tagged in code (SDK `markExpected`), so they count as successful; off: plain 4xx answers (for marking them from the dashboard).',
        default: 'on',
      },
      {
        key: 'expectedReason',
        summary: 'The reason label tagged answers carry.',
        default: OUT.expectedReason,
      },
    ],
  },
  {
    id: 'normal-inbound',
    title: 'Normal levels, webhooks',
    entries: [
      {
        key: 'rejected',
        summary: 'Deliveries our app answers non-2xx, as a share; varies ±50% by day.',
        default: pct(IN.rejected),
      },
      { key: 'handlerMs', summary: 'Median handling time in ms.', default: `${IN.handlerMs} ms` },
      {
        key: 'lagS',
        summary: 'Median seconds between the sender signing and the delivery arriving.',
        default: `${IN.lagS} s`,
      },
      {
        key: 'lateShare',
        summary: 'Share of deliveries that arrive 20–90 s late.',
        default: pct(IN.lateShare),
      },
      {
        key: 'signed',
        summary: 'The sender signs a timestamp; off: no delivery lag is measured.',
        default: 'on',
      },
      { key: 'noise', summary: 'Everyday noise, as for outgoing calls.', default: 'on' },
    ],
  },
  {
    id: 'faults',
    title: 'Faults',
    entries: [
      { key: 'id', summary: 'Name the expectations refer to.' },
      {
        key: 'target',
        summary:
          'The source: "PayCo POST /v1/charges", "NotifyCo webhooks /webhooks/notifyco", or its `id`.',
      },
      { key: 'at', summary: 'When it starts (see Times).', example: 'at: day 1 14:00' },
      { key: 'duration', summary: 'How long it lasts.', example: 'duration: 2h' },
      { key: 'type', summary: 'What goes wrong (see Fault types).' },
      {
        key: 'size',
        summary:
          'How bad: a share of calls (0–1) for error faults and rejected, × for latency, ms for slow, seconds for late.',
        default: 'per type (see Fault types)',
      },
      {
        key: 'ramp',
        summary: 'latency: grow from 1× to `size` over the duration (slow degradation).',
      },
      {
        key: 'status',
        summary:
          'rejected: the status our app answers (401 for a signing-secret mismatch). auth, not_found, validation: the status the provider answers instead of the usual one, never tagged expected (a contract change: `type: validation, status: 400`).',
        default: 'rejected 500; auth 401/403; not_found 404; validation 422',
      },
    ],
  },
  {
    id: 'fault-types',
    title: 'Fault types',
    intro: 'Outgoing types apply to endpoints, webhook types to webhook sources.',
    entries: [...OUTBOUND_FAULTS, ...INBOUND_FAULTS].map((t) => ({
      key: t,
      ...FAULT_ENTRIES[t],
      default: faultDefault(t),
      uses: [(OUTBOUND_FAULTS as readonly string[]).includes(t) ? 'outgoing' : 'webhooks'],
    })),
  },
  {
    id: 'expect',
    title: 'Expectations',
    intro: 'Checked live on the page and at the end of `pnpm sim:run` (exit 1 when one fails).',
    entries: [
      {
        key: 'incident',
        summary: 'An incident must open within `within` of fault `fault` starting.',
        example: 'expect:\n  - incident: { fault: outage, within: 10m, kind: errors }',
      },
      { key: 'fault', summary: 'incident: the fault id.' },
      { key: 'within', summary: 'incident: the longest acceptable time to open.' },
      {
        key: 'kind',
        summary: 'incident: required incident kind, or a list of them (see Incident kinds).',
        default: 'any',
      },
      {
        key: 'target',
        summary: 'incident / quiet: the source.',
        default: "the fault's source / every source",
      },
      {
        key: 'quiet',
        summary: 'No incident may open between `from` and `to`.',
        example: 'expect:\n  - quiet: { from: day 0 00:00, to: day 1 14:00 }',
      },
      { key: 'from', summary: 'quiet: window start.' },
      { key: 'to', summary: 'quiet: window end.' },
      {
        key: 'irregular',
        summary: 'Webhook source `target` must be marked irregular (silence alerts off) by `by`.',
        example:
          'expect:\n  - irregular: { target: NotifyCo webhooks /webhooks/notifyco, by: day 6 }',
      },
      { key: 'by', summary: 'irregular / discovered: the latest time.' },
      {
        key: 'discovered',
        summary:
          'Webhook source `target` (one with `discovery`) must be a candidate route by `by`, with the suggested `name` if given.',
        example:
          'expect:\n  - discovered: { target: OrbitPay webhooks /v1/orbitpay, by: day 0 01:00, name: orbitpay }',
      },
      { key: 'name', summary: 'discovered: the name the SDK should suggest.' },
    ],
  },
  {
    id: 'kinds',
    title: 'Incident kinds',
    intro: 'The `kind` values an incident can have.',
    entries: [...INCIDENT_KINDS, ...INBOUND_KINDS].map((k) => ({
      key: k,
      summary: KIND_ENTRIES[k] ?? '',
    })),
  },
];

/** Entries whose key or section id matches the topic (case-insensitive). */
export function findReference(topic: string): RefSection[] {
  const q = topic.toLowerCase();
  const exact = REFERENCE.filter((s) => s.id === q || s.title.toLowerCase() === q);
  if (exact.length) return exact;
  return REFERENCE.map((s) => ({
    ...s,
    entries: s.entries.filter((e) => e.key.toLowerCase() === q),
  })).filter((s) => s.entries.length);
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>');

/** docs/simulation-reference.md. */
export function referenceMarkdown(): string {
  const out = [
    '# Simulation scenario reference',
    '',
    '<!-- Generated from apps/collector/src/sim/reference.ts by `pnpm sim:help --write`; do not edit by hand. -->',
    '',
    "Every setting of a simulation scenario ([docs/demo.md](demo.md#simulate-weeks-in-minutes)): the same text as the Simulation page's field hints and Reference panel, and `pnpm sim:help [topic]`. Ready-made scenarios: `examples/sim/` (`pnpm sim:list`).",
    '',
    REFERENCE.map((s) => `[${s.title}](#${s.id})`).join(' · '),
    '',
  ];
  for (const s of REFERENCE) {
    out.push(`<a id="${s.id}"></a>`, '', `## ${s.title}`, '');
    if (s.intro) out.push(s.intro, '');
    const withUses = s.entries.some((e) => e.uses);
    out.push(
      `| Key | What it does | Default |${withUses ? ' Uses |' : ''}`,
      `|---|---|---|${withUses ? '---|' : ''}`,
    );
    for (const e of s.entries) {
      const what = [e.summary, e.detail].filter(Boolean).join(' ');
      out.push(
        `| \`${e.key}\` | ${mdCell(what)} | ${mdCell(e.default ?? '')} |${
          withUses ? ` ${(e.uses ?? []).map((u) => `\`${u}\``).join(', ')} |` : ''
        }`,
      );
    }
    const examples = s.entries.filter((e) => e.example);
    if (examples.length)
      out.push('', '```yaml', ...examples.map((e) => `# ${e.key}\n${e.example}`), '```');
    out.push('');
  }
  return out.join('\n');
}

/** Plain text for the terminal (`pnpm sim:help [topic]`). */
export function referenceText(sections: RefSection[] = REFERENCE): string {
  const out: string[] = [];
  for (const s of sections) {
    out.push(`${s.title.toUpperCase()}  (${s.id})`);
    if (s.intro) out.push(`  ${s.intro}`);
    const w = Math.min(16, Math.max(...s.entries.map((e) => e.key.length)));
    for (const e of s.entries) {
      out.push(`  ${e.key.padEnd(w)}  ${e.summary}`);
      const pad = ' '.repeat(w + 4);
      if (e.detail) out.push(`${pad}${e.detail}`);
      if (e.default) out.push(`${pad}default: ${e.default}`);
      if (e.uses?.length) out.push(`${pad}uses: ${e.uses.join(', ')}`);
      if (e.example) out.push(...e.example.split('\n').map((l) => `${pad}e.g. ${l}`));
    }
    out.push('');
  }
  return out.join('\n');
}
