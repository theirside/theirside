import { describe, expect, it } from 'vitest';
import type { AlertPayload } from '../src/modules/alerts/channels.js';
import {
  emailSubject,
  renderEmail,
  renderSlack,
  slackText,
  SLACK_LIMITS,
} from '../src/modules/alerts/render.js';
import { testPayload } from '../src/modules/alerts/routes.js';
import { digestPayload } from '../src/modules/discovery/jobs.js';
import type { ProviderRecord } from '../src/storage/types.js';

const OPEN: AlertPayload = {
  event: 'open',
  title: 'Acme Cards: POST /v2/cards/:id/activate failing (38%)',
  incidentId: 'inc_01',
  provider: 'Acme Cards',
  environment: 'production',
  status: 'open',
  kind: 'errors',
  endpoints: [
    {
      method: 'POST',
      endpoint: '/v2/cards/:id/activate',
      errorRate: 0.38,
      normalErrorRate: 0.002,
      p95Ms: 2480,
      normalP95Ms: 181,
    },
  ],
  otherEndpointsOk: true,
  otherEndpointsText: 'Other Acme Cards endpoints: OK.',
  summary: [
    'Acme Cards — POST /v2/cards/:id/activate failing since 10:20 UTC (6 min)',
    'Error rate 38% (normal 0.2%), 200 calls in window. Outcomes: 5xx 100%.',
    'p95 latency 2.5 s (normal 181 ms). Other Acme Cards endpoints: OK.',
    'Sample provider request IDs: req_fail_20_0, req_fail_20_1, req_fail_21_0',
    'Support: support@acmecards.test',
  ].join('\n'),
  url: 'https://theirside.internal.example/#/incidents/inc_01',
  openedAt: '2026-11-03T10:20:00.000Z',
  resolvedAt: null,
  durationMinutes: 6,
  support: { email: 'support@acmecards.test', url: 'https://status.acmecards.test' },
};

const RESOLVE: AlertPayload = {
  ...OPEN,
  event: 'resolve',
  status: 'resolved',
  title: 'Acme Cards: POST /v2/cards/:id/activate recovered',
  resolvedAt: '2026-11-03T10:40:00.000Z',
  durationMinutes: 20,
};

const LATENCY_NO_LINK: AlertPayload = {
  ...OPEN,
  kind: 'latency',
  title: 'Acme Cards: 7 endpoints slow',
  url: null,
  support: null,
  otherEndpointsOk: false,
  otherEndpointsText: 'Other Acme Cards endpoints: also degraded (GET /v2/cards).',
  endpoints: Array.from({ length: 7 }, (_, i) => ({
    method: 'GET',
    endpoint: `/v2/thing${i}/:id`,
    errorRate: 0,
    normalErrorRate: 0,
    p95Ms: 4100 + i,
    normalP95Ms: 300,
  })),
};

describe('Slack message', () => {
  it.each([
    ['open', OPEN],
    ['resolve', RESOLVE],
    ['latency, many endpoints, no dashboard link', LATENCY_NO_LINK],
  ])('%s', (_n, p) => {
    expect(renderSlack(p)).toMatchSnapshot();
  });

  it('has a plain-text fallback with the title and link', () => {
    expect(renderSlack(OPEN).text).toBe(
      'Incident opened: Acme Cards: POST `/v2/cards/:id/activate` failing (38%)\nOther Acme Cards endpoints: OK.\nhttps://theirside.internal.example/#/incidents/inc_01',
    );
  });

  it('omits the dashboard button when there is no URL', () => {
    const blocks = renderSlack(LATENCY_NO_LINK).blocks as { type: string }[];
    expect(blocks.map((b) => b.type)).not.toContain('actions');
    expect(renderSlack(LATENCY_NO_LINK).text).not.toMatch(/http/);
  });

  it('stays within Slack limits with oversized input', () => {
    const huge: AlertPayload = {
      ...OPEN,
      provider: 'P'.repeat(500),
      title: 'T'.repeat(5000),
      summary: 'S'.repeat(10_000),
      otherEndpointsText: 'O'.repeat(5000),
      environment: 'e'.repeat(3000),
      endpoints: Array.from({ length: 200 }, () => ({
        ...OPEN.endpoints[0]!,
        endpoint: '/x'.repeat(500),
      })),
    };
    const { text, blocks } = renderSlack(huge) as {
      text: string;
      blocks: { type: string; text?: { text: string }; fields?: { text: string }[] }[];
    };
    expect(text.length).toBeLessThanOrEqual(SLACK_LIMITS.fallbackText);
    expect(blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocks);
    for (const b of blocks) {
      if (b.type === 'header')
        expect(b.text!.text.length).toBeLessThanOrEqual(SLACK_LIMITS.headerText);
      if (b.type === 'section' && b.text)
        expect(b.text.text.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionText);
      for (const f of b.fields ?? [])
        expect(f.text.length).toBeLessThanOrEqual(SLACK_LIMITS.fieldText);
      expect((b.fields ?? []).length).toBeLessThanOrEqual(SLACK_LIMITS.fields);
    }
  });

  it('escapes Slack control characters from provider data', () => {
    const p = { ...OPEN, title: 'Evil <!channel> & co: x failing (1%)' };
    expect(JSON.stringify(renderSlack(p))).toContain('Evil &lt;!channel&gt; &amp; co');
  });
});

/** `:id` next to other text and colons, as seen in real traffic (":id:" became 🆔). */
const COLONS: AlertPayload = {
  ...OPEN,
  event: 'escalation',
  title: 'Example Provider: POST /v1/example/:id: errors 38%',
  provider: 'Example Provider',
  endpoints: [
    { ...OPEN.endpoints[0]!, endpoint: '/v1/example/:id' },
    { ...OPEN.endpoints[0]!, method: 'GET', endpoint: '/v1/:id:refund/:id' },
    { ...OPEN.endpoints[0]!, method: 'GET', endpoint: '/v2/line_items/*expand*' },
  ],
  otherEndpointsOk: false,
  otherEndpointsText:
    'Also degraded: GET /v1/:id:fire: and api.example.test:443/v2/:id. Status: https://status.example.test/:id',
  environment: 'prod:eu',
  support: { email: 'support@example.test', url: 'https://status.example.test' },
};

/** Text of every mrkdwn element and the fallback. */
function slackTexts(m: { text: string; blocks: unknown[] }): string[] {
  const out = [m.text];
  for (const b of m.blocks as {
    text?: { type: string; text: string };
    fields?: { text: string }[];
    elements?: { type: string; text?: string }[];
  }[]) {
    if (b.text?.type === 'mrkdwn') out.push(b.text.text);
    for (const f of b.fields ?? []) out.push(f.text);
    for (const e of b.elements ?? []) if (e.type === 'mrkdwn' && e.text) out.push(e.text);
  }
  return out;
}
/** What Slack would render as text: code spans, code blocks and URLs removed. */
const outsideCode = (t: string) =>
  t
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/https?:\/\/\S+/g, '');

describe('Slack: templates and hosts in inline code', () => {
  const DIGEST = digestPayload(
    [
      {
        name: 'geoapi.test',
        displayName: null,
        category: 'maps',
        hosts: ['api.geoapi.test', 'tiles.geoapi.test:8443'],
        hostPatterns: ['*.geoapi.test'],
        alertsEnabled: true,
      },
      {
        name: 'Fire:fire: Co',
        displayName: null,
        category: null,
        hosts: ['fire_co.test'],
        hostPatterns: [],
        alertsEnabled: false,
      },
    ] as ProviderRecord[],
    'https://theirside.internal.example',
  );
  const MESSAGES: [string, AlertPayload][] = [
    ['escalation with colons', COLONS],
    ['open with colons', { ...COLONS, event: 'open' }],
    [
      'resolve with colons',
      { ...COLONS, event: 'resolve', title: 'Example Provider: POST /v1/example/:id: recovered' },
    ],
    [
      'test alert',
      testPayload(
        'ops: alerts',
        'https://theirside.internal.example',
        new Date('2026-11-06T10:00:00Z'),
      ),
    ],
    ['discovery digest', DIGEST],
  ];

  it.each(MESSAGES)('%s: no :id or emoji shortcode outside code', (_n, p) => {
    for (const t of slackTexts(renderSlack(p))) {
      // our own status emoji are intended
      const rest = outsideCode(t).replace(
        /:(red_circle|rotating_light|large_green_circle|white_check_mark|warning|mag):/g,
        '',
      );
      expect(rest, t).not.toMatch(/:[a-z0-9_+-]+:/i);
      expect(rest, t).not.toContain(':id');
    }
  });

  it.each(MESSAGES)('%s: snapshot', (_n, p) => {
    expect(renderSlack(p)).toMatchSnapshot();
  });

  it('wraps paths and hosts, leaves URLs, emails and times alone', () => {
    expect(slackText('Example Provider: POST /v1/example/:id: errors 38%')).toBe(
      'Example Provider: POST `/v1/example/:id`: errors 38%',
    );
    expect(slackText('(GET /v2/cards). Since 10:20 UTC, p95 2.5 s, 0.2%')).toBe(
      '(GET `/v2/cards`). Since 10:20 UTC, p95 2.5 s, 0.2%',
    );
    expect(
      slackText('api.example.test:443/v2/:id, see https://x.example/:id or ops@x.example'),
    ).toBe('`api.example.test:443/v2/:id`, see https://x.example/:id or ops@x.example');
    expect(slackText('a & <b> `/x`')).toBe('a &amp; &lt;b&gt; `/x`');
    expect(slackText('Fire:fire: Co')).toBe('Fire:\u200bfire: Co');
  });

  it('the fallback text has the same treatment', () => {
    expect(renderSlack(testPayload('ops', 'https://t.example')).text).toBe(
      'Test alert: Example Provider: POST `/v1/example/:id` failing (38%)\nOther Example Provider endpoints: OK.\nhttps://t.example/#/incidents',
    );
  });
});

describe('email', () => {
  it.each([
    [OPEN, '[Theirside] Acme Cards POST /v2/cards/:id/activate failing 38%'],
    [RESOLVE, '[Theirside] Incident resolved: Acme Cards POST /v2/cards/:id/activate recovered'],
    [
      {
        ...OPEN,
        event: 'escalation' as const,
        title: 'Acme Cards: 2 endpoints failing (61%), getting worse',
      },
      '[Theirside] Incident escalated: Acme Cards 2 endpoints failing 61%, getting worse',
    ],
  ])('subject for %#', (p, subject) => {
    expect(emailSubject(p)).toBe(subject);
  });

  it.each([
    ['open', OPEN],
    ['resolve', RESOLVE],
    ['latency, many endpoints, no dashboard link', LATENCY_NO_LINK],
  ])('%s: text and HTML bodies', (_n, p) => {
    const m = renderEmail(p);
    expect(m.text).toMatchSnapshot('text');
    expect(m.html).toMatchSnapshot('html');
  });

  it('escapes HTML in provider data and has no link without a URL', () => {
    const m = renderEmail({ ...LATENCY_NO_LINK, title: '<script>alert(1)</script>' });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).not.toContain('href=');
    expect(m.text).not.toContain('Open in dashboard');
  });
});

describe('inbound webhook alerts', () => {
  const SILENCE: AlertPayload = {
    event: 'open',
    direction: 'inbound',
    title: 'No Stripe webhooks for 2h 10m; normally ~40/hour at this time',
    incidentId: 'inc_wh1',
    provider: 'Stripe',
    environment: 'production',
    status: 'open',
    kind: 'webhook_silence',
    endpoints: [
      {
        method: 'POST',
        endpoint: '/webhooks/stripe',
        errorRate: null,
        normalErrorRate: null,
        p95Ms: null,
        normalP95Ms: null,
      },
    ],
    otherEndpointsOk: true,
    otherEndpointsText: 'No other Stripe webhook routes.',
    summary: [
      'Stripe webhooks — POST /webhooks/stripe: no deliveries since 11:50 UTC (2h 10m)',
      'Normally ~40/hour at this time of week; ~87 expected in this gap (chance of none: < 0.0001%).',
      'Our receiving service (payments-api) is running and reporting.',
    ].join('\n'),
    url: 'https://theirside.internal.example/#/incidents/inc_wh1',
    openedAt: '2026-11-10T11:50:00.000Z',
    resolvedAt: null,
    durationMinutes: 130,
    support: null,
    webhook: {
      lastDeliveryAt: '2026-11-10T11:49:00.000Z',
      silentMinutes: 130,
      expectedPerHour: 40.2,
      pValue: 1e-12,
      authShare: null,
      lagP95S: null,
      normalLagP95S: 2,
    },
  };
  const REJECTED: AlertPayload = {
    ...SILENCE,
    incidentId: 'inc_wh2',
    kind: 'webhook_rejections',
    title: 'GitHub webhooks rejected by our app (38%, mostly 401/403)',
    provider: 'GitHub',
    endpoints: [
      {
        method: 'POST',
        endpoint: '/webhooks/github',
        errorRate: 0.38,
        normalErrorRate: 0.002,
        p95Ms: 41,
        normalP95Ms: 38,
      },
    ],
    otherEndpointsText: 'No other GitHub webhook routes.',
    summary:
      'GitHub webhooks — POST /webhooks/github: rejected by our app since 14:02 UTC (6m)\nMost are 401/403 from our app: the webhook signing secret likely does not match (rotated, or test vs live mode).',
  };

  it('Slack names the webhooks and says "rejected", not "errors"', () => {
    const s = renderSlack(SILENCE);
    expect(JSON.stringify(s.blocks[0])).toContain('Incident opened: Stripe webhooks');
    expect(s.text).toContain('No Stripe webhooks for 2h 10m; normally ~40/hour at this time');
    const r = JSON.stringify(renderSlack(REJECTED).blocks);
    expect(r).toContain('rejected 38% (normal 0.2%), handler p95 41 ms (normal 38 ms)');
    expect(r).not.toContain('errors 38%');
    expect(renderSlack(SILENCE)).toMatchSnapshot();
  });

  it('email subject and body', () => {
    expect(emailSubject(SILENCE)).toBe(
      '[Theirside] No Stripe webhooks for 2h 10m; normally ~40/hour at this time',
    );
    const e = renderEmail(REJECTED);
    expect(e.text).toContain('- POST /webhooks/github: rejected 38% (normal 0.2%)');
    expect(e.text).toContain('signing secret likely does not match');
    expect(renderEmail(SILENCE).text).toMatchSnapshot();
  });
});
