import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicPath } from '../src/server.js';
import {
  batch,
  event,
  ingestRequest,
  startTestApp,
  THEIRSIDE_ADMIN_TOKEN,
  TEST_API_KEY,
  type TestApp,
} from './helpers.js';

describe('THEIRSIDE_PUBLIC_PATHS_ONLY', () => {
  it.each([
    ['/status/AbCdEf0123456789', true],
    ['/embed.js', true],
    ['/healthz', true],
    ['/readyz', true],
    ['/status/a/b', false],
    ['/status/', false],
    ['/', false],
    ['/index.html', false],
    ['/assets/app.js', false],
    ['/v1/ingest', false],
    ['/v1/health', false],
    ['/v1/auth/login', false],
    ['/v1/admin/overview', false],
    ['/embed.js.map', false],
  ])('%s → %s', (path, allowed) => {
    expect(isPublicPath(path)).toBe(allowed);
  });

  let t: TestApp;
  let token: string;
  beforeAll(async () => {
    t = await startTestApp({ env: { THEIRSIDE_PUBLIC_PATHS_ONLY: 'true' } });
    token = (
      await t.db.storage.config.listStatusPages({ orgId: t.orgId, projectId: t.projectId })
    )[0]!.publicToken;
  });
  afterAll(async () => {
    await t.close();
  });

  it('serves the status page, embed.js and health checks', async () => {
    for (const url of [
      `/status/${token}`,
      `/status/${token}?theme=dark&embed=1`,
      '/embed.js',
      '/healthz',
      '/readyz',
    ])
      expect((await t.app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
  });

  it('404s everything else, even with valid credentials', async () => {
    const admin = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };
    expect((await t.app.inject(ingestRequest(batch([event()]), TEST_API_KEY))).statusCode).toBe(
      404,
    );
    for (const [method, url, headers] of [
      ['GET', '/', {}],
      ['GET', '/v1/admin/overview', admin],
      ['GET', '/v1/health', { authorization: `Bearer ${TEST_API_KEY}` }],
      ['POST', '/v1/auth/login', {}],
    ] as const)
      expect((await t.app.inject({ method, url, headers })).statusCode, url).toBe(404);
  });
});
