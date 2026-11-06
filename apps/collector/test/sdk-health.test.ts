import { describe, expect, it } from 'vitest';
import { sdkHealth } from '../src/modules/api/sdk-health.js';
import type { SdkInstanceRecord, SdkProcessRecord } from '../src/storage/types.js';

const MIN = 60_000;
const NOW = new Date(Date.UTC(2026, 10, 7, 12, 0));
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const service = (s: Partial<SdkInstanceRecord> = {}): SdkInstanceRecord => ({
  orgId: 'o',
  projectId: 'p',
  service: 'billing',
  environment: 'production',
  sdkName: '@theirside/sdk',
  sdkVersion: '0.2.0',
  firstSeenAt: ago(7 * 24 * 60 * MIN),
  lastSeenAt: ago(MIN),
  lastEventAt: ago(MIN),
  droppedEvents: 0,
  lastFlushError: null,
  serverless: false,
  platform: null,
  eventGapSeconds: 5,
  eventBatches: 5000,
  ...s,
});
const proc = (p: Partial<SdkProcessRecord> = {}): SdkProcessRecord => ({
  orgId: 'o',
  projectId: 'p',
  service: 'billing',
  environment: 'production',
  instanceId: Math.random().toString(36).slice(2),
  startedAt: ago(3 * 60 * MIN),
  firstSeenAt: ago(3 * 60 * MIN),
  lastSeenAt: ago(MIN),
  lastEventAt: ago(MIN),
  sdkVersion: '0.2.0',
  runtime: 'node',
  runtimeVersion: '24.13.0',
  platform: null,
  serverless: false,
  ...p,
});
const lambda = (minutesAgo: number) =>
  proc({
    serverless: true,
    platform: 'aws-lambda',
    startedAt: ago(minutesAgo * MIN + 30_000),
    lastSeenAt: ago(minutesAgo * MIN),
  });

describe('long-running services (heartbeats)', () => {
  it('running: calls in the last minutes', () => {
    expect(sdkHealth(service(), [proc(), proc()], NOW)).toMatchObject({
      kind: 'long-running',
      status: 'running',
      stale: false,
      processes: { active: 2, lastDay: 2 },
    });
  });

  it("idle: heartbeats arrive, calls don't", () => {
    const s = service({ lastSeenAt: ago(2 * MIN), lastEventAt: ago(90 * MIN) });
    expect(sdkHealth(s, [proc({ lastSeenAt: ago(2 * MIN) })], NOW)).toMatchObject({
      status: 'idle',
      stale: false,
    });
  });

  it('not running: no batch, not even a heartbeat, for 15 minutes', () => {
    const s = service({ lastSeenAt: ago(20 * MIN), lastEventAt: ago(20 * MIN) });
    expect(sdkHealth(s, [proc({ lastSeenAt: ago(20 * MIN) })], NOW)).toMatchObject({
      status: 'not_running',
      stale: true,
      processes: { active: 0, lastDay: 1 },
    });
  });
});

describe('short-lived services (functions, cron, scripts)', () => {
  it('never stale by minutes: 3 cold starts, last invocation 40 minutes ago', () => {
    const s = service({
      service: 'card-sync',
      serverless: true,
      platform: 'aws-lambda',
      lastSeenAt: ago(40 * MIN),
      lastEventAt: ago(40 * MIN),
      eventGapSeconds: 600,
      eventBatches: 30,
    });
    const ps = [lambda(40), lambda(50), lambda(60)].map((p) => ({ ...p, service: 'card-sync' }));
    expect(sdkHealth(s, ps, NOW)).toMatchObject({
      kind: 'short-lived',
      status: 'ok',
      stale: false,
      platform: 'aws-lambda',
      processes: { lastDay: 3 },
      lastEventAt: ago(40 * MIN).toISOString(),
    });
  });

  it('silent: it sent regularly (every 2 min) and has been quiet for 8× that and an hour', () => {
    const s = service({
      serverless: true,
      lastEventAt: ago(70 * MIN),
      lastSeenAt: ago(70 * MIN),
      eventGapSeconds: 120,
      eventBatches: 200,
    });
    expect(sdkHealth(s, [], NOW)).toMatchObject({ status: 'silent', stale: true });
    // 50 minutes: past 8 gaps (16 min) but under the hour
    expect(
      sdkHealth({ ...s, lastEventAt: ago(50 * MIN), lastSeenAt: ago(50 * MIN) }, [], NOW).status,
    ).toBe('ok');
  });

  it('a daily job that ran yesterday is fine; one that missed two days is silent', () => {
    const daily = service({ eventGapSeconds: 24 * 3600, eventBatches: 30, serverless: true });
    expect(sdkHealth({ ...daily, lastEventAt: ago(23 * 60 * MIN) }, [], NOW).status).toBe('ok');
    expect(sdkHealth({ ...daily, lastEventAt: ago(9 * 24 * 60 * MIN) }, [], NOW).status).toBe(
      'silent',
    );
  });

  it('irregular (few batches): never warned about', () => {
    const s = service({
      serverless: true,
      lastEventAt: ago(30 * 24 * 60 * MIN),
      eventGapSeconds: 60,
      eventBatches: 3,
    });
    expect(sdkHealth(s, [], NOW).status).toBe('ok');
  });

  it('processes that live under 10 minutes make a service short-lived without serverless mode (cron)', () => {
    const cron = [0, 60, 120].map((m) =>
      proc({ startedAt: ago(m * MIN + 2 * MIN), lastSeenAt: ago(m * MIN) }),
    );
    expect(sdkHealth(service({ lastSeenAt: ago(30 * MIN) }), cron, NOW).kind).toBe('short-lived');
  });
});

describe('older SDKs (no process ids, no heartbeat)', () => {
  it('stale after 10 minutes, as before', () => {
    expect(sdkHealth(service({ sdkVersion: '0.1.2' }), [], NOW)).toMatchObject({
      kind: 'legacy',
      status: 'running',
    });
    expect(
      sdkHealth(service({ sdkVersion: '0.1.2', lastSeenAt: ago(11 * MIN) }), [], NOW),
    ).toMatchObject({
      kind: 'legacy',
      status: 'stale',
      stale: true,
    });
  });

  it('lists the SDK versions seen during a rollout', () => {
    const r = sdkHealth(
      service({ sdkVersion: '0.2.0' }),
      [proc({ sdkVersion: '0.1.2' }), proc()],
      NOW,
    );
    expect(r.sdkVersions).toEqual(['0.1.2', '0.2.0']);
  });
});
