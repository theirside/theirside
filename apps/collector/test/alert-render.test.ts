import { describe, expect, it } from 'vitest';
import type { AlertPayload } from '../src/modules/alerts/channels.js';
import {
  emailSubject,
  renderEmail,
  renderSlack,
  SLACK_LIMITS,
} from '../src/modules/alerts/render.js';

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
      'Incident opened: Acme Cards: POST /v2/cards/:id/activate failing (38%)\nOther Acme Cards endpoints: OK.\nhttps://theirside.internal.example/#/incidents/inc_01',
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
