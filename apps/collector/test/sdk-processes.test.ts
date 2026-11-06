import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/util/clock.js';
import { batch, event, ingestRequest, startTestApp, type TestApp } from './helpers.js';

const MIN = 60_000;
const START = Date.UTC(2026, 10, 7, 9, 0);
let t: TestApp;
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });

async function send(at: number, body: Parameters<typeof batch>[1], events = [event({ ts: at })]) {
  t.clock.set(at);
  const res = await t.app.inject(ingestRequest(batch(events, body)));
  expect(res.statusCode).toBe(202);
}
const instance = (id: string, startedAt = START) => ({ instance: { id, startedAt } });
const runtime = {
  runtime: { name: 'node', version: '24.13.0', platform: null, serverless: false },
};

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(START) });
});
afterAll(async () => t.close());

describe('SDK processes and heartbeats', () => {
  it('a heartbeat (no events) updates last seen, not last call', async () => {
    await send(START, { service: 'billing', ...instance('aaaa'), ...runtime });
    await send(START + 10 * MIN, { service: 'billing', ...instance('aaaa'), ...runtime }, []);
    const [svc] = (await t.db.storage.config.listSdkInstances(tenant())).filter(
      (s) => s.service === 'billing',
    );
    expect(svc).toMatchObject({
      lastSeenAt: new Date(START + 10 * MIN),
      lastEventAt: new Date(START),
      serverless: false,
    });
    const [proc] = await t.db.storage.config.listSdkProcesses(tenant(), new Date(START - MIN));
    expect(proc).toMatchObject({
      service: 'billing',
      instanceId: 'aaaa',
      startedAt: new Date(START),
      lastSeenAt: new Date(START + 10 * MIN),
      lastEventAt: new Date(START),
      runtime: 'node',
      runtimeVersion: '24.13.0',
    });
  });

  it('a restart is a new process; serverless cold starts are counted the same way', async () => {
    await send(START + 20 * MIN, {
      service: 'billing',
      ...instance('bbbb', START + 19 * MIN),
      ...runtime,
    });
    for (const id of ['l1', 'l2', 'l3'])
      await send(START + 21 * MIN, {
        service: 'card-sync',
        ...instance(id, START + 21 * MIN),
        runtime: { name: 'node', platform: 'aws-lambda', serverless: true },
      });
    const procs = await t.db.storage.config.listSdkProcesses(tenant(), new Date(START - MIN));
    expect(
      procs
        .filter((p) => p.service === 'billing')
        .map((p) => p.instanceId)
        .sort(),
    ).toEqual(['aaaa', 'bbbb']);
    expect(procs.filter((p) => p.service === 'card-sync' && p.serverless)).toHaveLength(3);
    const svc = (await t.db.storage.config.listSdkInstances(tenant())).find(
      (s) => s.service === 'card-sync',
    );
    expect(svc).toMatchObject({ serverless: true, platform: 'aws-lambda' });
  });

  it('older SDKs (no instance, no runtime) still work and keep what a newer one said', async () => {
    await send(START + 30 * MIN, { service: 'card-sync' });
    const svc = (await t.db.storage.config.listSdkInstances(tenant())).find(
      (s) => s.service === 'card-sync',
    );
    expect(svc).toMatchObject({ serverless: true, lastEventAt: new Date(START + 30 * MIN) });
  });

  it('a start time in the future is clamped to when the batch arrived', async () => {
    await send(START + 40 * MIN, { service: 'skewed', ...instance('cccc', START + 999 * MIN) });
    const p = (await t.db.storage.config.listSdkProcesses(tenant(), new Date(START))).find(
      (x) => x.instanceId === 'cccc',
    );
    expect(p!.startedAt).toEqual(new Date(START + 40 * MIN));
  });

  it('process rows are pruned a week after last seen', async () => {
    expect(await t.db.storage.config.pruneSdkProcesses(new Date(START + 5 * MIN))).toBe(0);
    const pruned = await t.db.storage.config.pruneSdkProcesses(new Date(START + 25 * MIN));
    expect(pruned).toBe(5); // aaaa (last seen +10), bbbb (+20), l1-l3 (+21); cccc (+40) stays
  });
});
