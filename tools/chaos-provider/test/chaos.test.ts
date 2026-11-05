import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChaosServer } from '../src/server.js';

let chaos: ReturnType<typeof createChaosServer>;
let url: string;
beforeAll(async () => {
  chaos = createChaosServer({ baseLatencyMs: [0, 1], sinkSecret: 'sink-secret-0123456789' });
  await new Promise<void>((r) => chaos.server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(chaos.server.address() as AddressInfo).port}`;
});
afterAll(() => chaos.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJson = async (res: Response): Promise<any> => res.json();
const rule = (body: object) =>
  fetch(`${url}/__chaos/rules`, { method: 'POST', body: JSON.stringify(body) }).then(getJson);

describe('chaos provider', () => {
  it('answers like a provider API with a request id', async () => {
    const res = await fetch(`${url}/v2/cards/c_1/activate`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{12}$/);
  });

  it('fails a matching endpoint at the configured rate and nothing else', async () => {
    await rule({ path: '/v2/cards/:id/activate', method: 'POST', errorRate: 1, errorStatus: 502 });
    expect((await fetch(`${url}/v2/cards/c_9/activate`, { method: 'POST' })).status).toBe(502);
    expect((await fetch(`${url}/v2/cards/c_9`, { method: 'GET' })).status).toBe(200);
    expect((await fetch(`${url}/v2/cards/c_9/activate`, { method: 'GET' })).status).toBe(200);
    await fetch(`${url}/__chaos/rules`, { method: 'DELETE' });
  });

  it('resets, times out and adds latency', async () => {
    await rule({ path: '/v1/reset', resetRate: 1 });
    await expect(fetch(`${url}/v1/reset`)).rejects.toThrow();
    await rule({ path: '/v1/hang', timeoutRate: 1, hangMs: 5000 });
    await expect(fetch(`${url}/v1/hang`, { signal: AbortSignal.timeout(100) })).rejects.toThrow();
    await rule({ path: '/v1/slow', latencyMs: 150 });
    const t0 = Date.now();
    await fetch(`${url}/v1/slow`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    await fetch(`${url}/__chaos/rules`, { method: 'DELETE' });
  });

  it('expires rules after durationSeconds', async () => {
    const r = await rule({ path: '/x', errorRate: 1, durationSeconds: 0.05 });
    expect(r.expiresAt).toBeGreaterThan(Date.now());
    await new Promise((res) => setTimeout(res, 80));
    expect((await getJson(await fetch(`${url}/__chaos`))).rules).toEqual([]);
  });

  it('records alerts and checks webhook signatures', async () => {
    await fetch(`${url}/__alerts`, {
      method: 'POST',
      body: '{"event":"open"}',
      headers: { 'x-theirside-signature': 't=1,v1=' + '0'.repeat(64) },
    });
    const { alerts } = await getJson(await fetch(`${url}/__alerts`));
    expect(alerts[0]).toMatchObject({ signatureValid: false, body: { event: 'open' } });
  });
});
