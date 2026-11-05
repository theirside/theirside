import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AlertPayload } from '../src/modules/alerts/channels.js';
import { DEV_LICENSE_PRIVATE_KEY } from '../src/modules/entitlements/dev-keys.js';
import { signLicense } from '../src/modules/entitlements/license.js';
import { alertJob, incidentJob } from '../src/modules/incidents/job.js';
import { partitionJob } from '../src/modules/scheduler/maintenance.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import { FakeClock } from '../src/util/clock.js';
import { batch, event, ingestRequest, startTestApp, type TestApp } from './helpers.js';

// Licence state must never block alerting (architecture §2, §4): with an expired
// or malformed THEIRSIDE_LICENSE_KEY the install runs on OSS entitlements and still alerts.

const MIN = 60_000;
const START = Date.UTC(2026, 10, 3, 10, 0);
const FAIL_FROM = 20;
const FAIL_TO = 26;

const LICENCES: [string, () => string][] = [
  [
    'expired',
    () =>
      signLicense(
        {
          iss: 'theirside',
          sub: 'Example Co',
          plan: 'business',
          iat: START / 1000 - 60 * 86400,
          exp: START / 1000 - 86400,
          ent: { networkView: true, sso: true },
        },
        DEV_LICENSE_PRIVATE_KEY,
      ),
  ],
  ['malformed', () => 'not.a-valid.licence'],
];

async function receiver() {
  const got: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push(body);
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

describe('licence state never blocks alerts', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it.each(LICENCES)(
    'delivers the alert with an %s licence key',
    async (_name, licence) => {
      const t: TestApp = await startTestApp({
        clock: new FakeClock(START),
        env: { THEIRSIDE_LICENSE_KEY: licence(), THEIRSIDE_ALLOW_DEV_LICENSE: '1' },
      });
      const webhook = await receiver();
      cleanup = async () => {
        webhook.close();
        await t.close();
      };

      // the licence really is rejected: OSS entitlements
      expect((await t.ctx.entitlements.for(t.orgId)).source).toBe('oss');

      const tenant = { orgId: t.orgId, projectId: t.projectId };
      await t.db.storage.config.createAlertChannel(tenant, {
        kind: 'webhook',
        name: 'ops webhook',
        config: { url: webhook.url, secret: 'whsec_test_0123456789abcdef' },
        enabled: true,
      });
      const scheduler = new Scheduler(
        t.db.storage,
        t.clock,
        [
          partitionJob(t.db.storage, { ahead: 3, rawRetentionDays: 30 }),
          incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: 'http://collector.test' }),
          alertJob(t.ctx.alerts),
        ],
        { info() {}, error() {} },
      );

      // healthy warm-up, then one endpoint at 40% provider errors for 6 minutes
      for (let m = 0; m < FAIL_TO; m++) {
        const failing = m >= FAIL_FROM;
        const base = START + m * MIN;
        const events = Array.from({ length: 40 }, (_, i) =>
          event({
            ts: base + i * 1000,
            ...(failing && i % 5 < 2
              ? { status: 503, outcome: 'http_5xx' as const, providerRequestId: `req_${m}_${i}` }
              : { status: 200, outcome: 'ok' as const }),
          }),
        );
        t.clock.set(base + 50_000);
        expect((await t.app.inject(ingestRequest(batch(events)))).statusCode).toBe(202);
        t.clock.set(base + MIN + 5000);
        await scheduler.tick();
      }

      const sent = webhook.got.map((b) => JSON.parse(b) as AlertPayload);
      expect(sent.map((p) => p.event)).toEqual(['open']);
      expect(sent[0]!.provider).toBe('Acme Cards');
      const deliveries = await t.db.storage.config.listDeliveries(tenant, 10);
      expect(deliveries.map((d) => [d.event, d.status])).toEqual([['open', 'sent']]);
    },
    120_000,
  );
});
