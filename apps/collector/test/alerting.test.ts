import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook, type AlertPayload } from '../src/modules/alerts/channels.js';
import { MAX_ATTEMPTS } from '../src/modules/alerts/dispatcher.js';
import { alertJob, incidentJob } from '../src/modules/incidents/job.js';
import { partitionJob } from '../src/modules/scheduler/maintenance.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import { FakeClock } from '../src/util/clock.js';
import { batch, event, ingestRequest, startTestApp, type TestApp } from './helpers.js';

const MIN = 60_000;
const SECRET = 'whsec_test_0123456789abcdef';

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function receiver(status: () => number = () => 200) {
  const got: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.statusCode = status();
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    got,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    close: () => server.close(),
  };
}

const START = Date.UTC(2026, 10, 3, 10, 0);
let t: TestApp;
let webhook: Awaited<ReturnType<typeof receiver>>;
let slack: Awaited<ReturnType<typeof receiver>>;
let scheduler: Scheduler;

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(START) });
  webhook = await receiver();
  slack = await receiver();
  const tenant = { orgId: t.orgId, projectId: t.projectId };
  await t.db.storage.config.createAlertChannel(tenant, {
    kind: 'webhook',
    name: 'ops webhook',
    config: { url: webhook.url, secret: SECRET },
    enabled: true,
  });
  await t.db.storage.config.createAlertChannel(tenant, {
    kind: 'slack',
    name: '#alerts',
    config: { webhookUrl: slack.url },
    enabled: true,
  });
  await t.db.storage.config.upsertProvider(tenant, {
    name: 'Acme Cards',
    hostPatterns: ['api.acmecards.test'],
    explicitRoutes: [],
    supportEmail: 'support@acmecards.test',
    supportUrl: null,
    supportNotes: null,
    publicDisplayName: 'Card issuing',
    isPublic: true,
  });
  scheduler = new Scheduler(
    t.db.storage,
    t.clock,
    [
      partitionJob(t.db.storage, { ahead: 3, rawRetentionDays: 30 }),
      incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: 'http://collector.test' }),
      alertJob(t.ctx.alerts),
    ],
    { info() {}, error() {} },
  );
});
afterAll(async () => {
  webhook.close();
  slack.close();
  await t.close();
});

const ENDPOINTS = ['/v2/cards/:id/activate', '/v2/cards/:id', '/v2/cards'];

/** One minute of traffic through the real ingest API, then the scheduler tick at the next minute + 5 s. */
async function minute(m: number, failActivate: boolean) {
  const base = START + m * MIN;
  const events = [];
  for (let i = 0; i < 40; i++) {
    for (const endpoint of ENDPOINTS) {
      const fail = failActivate && endpoint === ENDPOINTS[0] && i % 5 < 2; // 40%
      events.push(
        event({
          ts: base + i * 1000,
          endpoint,
          ...(fail
            ? {
                status: 503,
                outcome: 'http_5xx' as const,
                providerRequestId: `req_fail_${m}_${i}`,
                durationMs: 2500,
              }
            : { status: 200, outcome: 'ok' as const, durationMs: 180 }),
        }),
      );
    }
  }
  t.clock.set(base + 50_000);
  const res = await t.app.inject(ingestRequest(batch(events)));
  expect(res.statusCode).toBe(202);
  t.clock.set(base + MIN + 5000);
  await scheduler.tick();
}

describe('end-to-end with a fake clock: one endpoint at 40% for 6 minutes', () => {
  const FAIL_FROM = 20;
  const FAIL_TO = 26;

  beforeAll(async () => {
    for (let m = 0; m < 60; m++) await minute(m, m >= FAIL_FROM && m < FAIL_TO);
  }, 120_000);

  const events = () => webhook.got.map((g) => (JSON.parse(g.body) as AlertPayload).event);

  it('sends exactly one open and one resolve to each channel', () => {
    expect(events()).toEqual(['open', 'resolve']);
    expect(slack.got).toHaveLength(2);
  });

  it('opens within 4 minutes, names the endpoint and says the others are OK', async () => {
    const open = JSON.parse(webhook.got[0]!.body) as AlertPayload;
    const deliveries = await t.db.storage.config.listDeliveries(
      { orgId: t.orgId, projectId: t.projectId },
      10,
    );
    const openDelivery = deliveries.find((d) => d.event === 'open' && d.status === 'sent')!;
    expect(openDelivery.sentAt!.getTime() - (START + FAIL_FROM * MIN)).toBeLessThanOrEqual(
      4 * MIN + 5000,
    );
    expect(open.endpoints.map((e) => `${e.method} ${e.endpoint}`)).toEqual([
      'POST /v2/cards/:id/activate',
    ]);
    expect(open.otherEndpointsOk).toBe(true);
    expect(open.otherEndpointsText).toBe('Other Acme Cards endpoints: OK.');
    expect(open.title).toMatch(/^Acme Cards: POST \/v2\/cards\/:id\/activate failing \(\d+%\)$/);
    expect(open.url).toBe(`http://collector.test/#/incidents/${open.incidentId}`);
  });

  it('carries a paste-ready summary for the provider', () => {
    const open = JSON.parse(webhook.got[0]!.body) as AlertPayload;
    const lines = open.summary.split('\n');
    expect(lines[0]).toMatch(
      /^Acme Cards — POST \/v2\/cards\/:id\/activate failing since \d\d:\d\d UTC \(\d+ min\)$/,
    );
    expect(lines[1]).toMatch(
      /^Error rate \d+% \(normal [\d.]+%(, still learning)?\), \d+ calls in window\. Outcomes: 5xx 100%\.$/,
    );
    expect(lines[2]).toMatch(
      /^p95 latency [\d.]+ s \(normal \d+ ms\)\. Other Acme Cards endpoints: OK\.$/,
    );
    expect(lines[3]).toMatch(
      /^Sample provider request IDs: req_fail_\d+_\d+(, req_fail_\d+_\d+){2,4}$/,
    );
    expect(lines[4]).toBe('Support: support@acmecards.test');
  });

  it('signs webhooks with HMAC-SHA256 over timestamp and body', () => {
    for (const g of webhook.got) {
      const sig = String(g.headers['x-theirside-signature']);
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig)!;
      expect(m).not.toBeNull();
      const expected = createHmac('sha256', SECRET).update(`${m[1]}.${g.body}`).digest('hex');
      expect(m[2]).toBe(expected);
      expect(g.headers['x-theirside-event']).toMatch(/open|resolve/);
    }
    expect(signWebhook('s', 1, 'b')).toMatch(/^t=1,v1=/);
  });

  it('posts Block Kit to Slack', () => {
    const body = JSON.parse(slack.got[0]!.body);
    expect(body.text).toMatch(/Acme Cards/);
    expect(body.blocks.map((b: { type: string }) => b.type)).toEqual([
      'header', // Incident opened: Acme Cards
      'section', // title
      'section', // duration, environment, provider support
      'section', // endpoint lines
      'section', // other endpoints OK
      'section', // summary for the provider
      'actions', // Open in dashboard
      'context',
    ]);
    const json = JSON.stringify(body.blocks);
    expect(json).toContain('Other Acme Cards endpoints: OK.');
    expect(json).toContain('support@acmecards.test');
    expect(json).toMatch(/errors \d+% \(normal [\d.]+%\)/);
    expect(json).toContain('http://collector.test/#/incidents/');
  });

  it('stores the incident with summary, samples and recovery', async () => {
    const [inc] = await t.db.storage.incidents.list({ orgId: t.orgId, projectId: t.projectId }, {});
    expect(inc).toMatchObject({
      status: 'resolved',
      scope: 'endpoint',
      kind: 'errors',
      provider: 'Acme Cards',
    });
    expect(inc!.sampleRequestIds.length).toBeGreaterThanOrEqual(3);
    expect(inc!.summary).toMatch(/recovered at \d\d:\d\d UTC after \d+ min/);
    expect(inc!.endpoints[0]!.recoveredAt).not.toBeNull();
    const resolve = JSON.parse(webhook.got[1]!.body) as AlertPayload;
    expect(resolve).toMatchObject({ event: 'resolve', status: 'resolved', incidentId: inc!.id });
  });

  it('keeps incident minutes out of the baseline', async () => {
    const b = (
      await t.db.storage.incidents.getBaselines({ orgId: t.orgId, projectId: t.projectId })
    ).find((x) => x.endpoint === ENDPOINTS[0])!;
    expect(b.providerErrorRate).toBeLessThan(0.02);
  });
});

describe('alert delivery retries', () => {
  it('retries with backoff, logs attempts, and gives up after the last attempt', async () => {
    let fail = 2;
    const flaky = await receiver(() => (fail-- > 0 ? 500 : 200));
    const dead = await receiver(() => 500);
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    const flakyCh = await t.db.storage.config.createAlertChannel(tenant, {
      kind: 'webhook',
      name: 'flaky',
      config: { url: flaky.url, secret: SECRET },
      enabled: false,
    });
    const deadCh = await t.db.storage.config.createAlertChannel(tenant, {
      kind: 'webhook',
      name: 'dead',
      config: { url: dead.url, secret: SECRET },
      enabled: false,
    });
    const payload: AlertPayload = {
      event: 'test',
      title: 'Test alert',
      incidentId: null,
      provider: 'Acme Cards',
      environment: 'production',
      status: 'test',
      endpoints: [],
      otherEndpointsOk: true,
      otherEndpointsText: '',
      summary: 'test',
      url: null,
      openedAt: null,
      resolvedAt: null,
    };
    const [d1] = await t.ctx.alerts.enqueue(tenant, payload, { onlyChannelId: flakyCh.id });
    const [d2] = await t.ctx.alerts.enqueue(tenant, payload, { onlyChannelId: deadCh.id });
    for (let i = 0; i < 12; i++) {
      await t.ctx.alerts.sendDue();
      t.clock.advance(10 * MIN);
    }
    const rows = await t.db.storage.config.listDeliveries(tenant, 50);
    const r1 = rows.find((r) => r.id === d1!.id)!;
    const r2 = rows.find((r) => r.id === d2!.id)!;
    expect(r1).toMatchObject({ status: 'sent', attempts: 3, lastError: null });
    expect(r2).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      lastError: expect.stringMatching(/^HTTP 500 from 127\.0\.0\.1:\d+: ok$/),
    });
    expect(flaky.got).toHaveLength(3);
    expect(dead.got).toHaveLength(MAX_ATTEMPTS);
    flaky.close();
    dead.close();
  });
});
