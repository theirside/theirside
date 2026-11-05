import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/coexist-launch.cjs', import.meta.url));

interface ScenarioResult {
  results: string[];
  sdkEvents: string[];
  xraySubsegments: string[] | null;
  otelClientSpans: string[] | null;
  nockDone: boolean | null;
}

/** Each scenario runs in a fresh process: instrumentation order is global state. */
function run(order: string): Promise<ScenarioResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      // ipv4first: see vitest.setup.ts
      ['--conditions=@theirside/source', '--dns-result-order=ipv4first', fixture, order],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30_000 },
      (err, stdout, stderr) => {
        const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
        if (!line)
          return reject(
            new Error(`scenario ${order} failed: ${err?.message}\n${stdout}\n${stderr}`),
          );
        resolve(JSON.parse(line.slice('RESULT '.length)) as ScenarioResult);
      },
    );
  });
}

const ALL_CALLS = ['/v1/axios ok', '/v1/fetch ok', '/v1/http ok', '/v1/https ok'];
const OK = '{"ok":true}';

describe('coexistence with other instrumentation', () => {
  it.each(['sdk,xray', 'xray,sdk'])('AWS X-Ray captureHTTPsGlobal (%s)', async (order) => {
    const r = await run(order);
    expect(r.results).toEqual([OK, OK, OK, OK]);
    expect(r.sdkEvents).toEqual(ALL_CALLS);
    // X-Ray still records http, https and axios (it does not capture fetch); no SDK flush in it
    expect(r.xraySubsegments).toEqual(['localhost', 'localhost', 'localhost']);
  });

  it.each(['sdk,otel', 'otel,sdk'])('OpenTelemetry http instrumentation (%s)', async (order) => {
    const r = await run(order);
    expect(r.results).toEqual([OK, OK, OK, OK]);
    expect(r.sdkEvents).toEqual(ALL_CALLS);
    expect(r.otelClientSpans).toHaveLength(3);
  });

  it.each(['xray,otel,sdk', 'sdk,otel,xray'])('X-Ray and OTel together (%s)', async (order) => {
    const r = await run(order);
    expect(r.sdkEvents).toEqual(ALL_CALLS);
    expect(r.xraySubsegments).toHaveLength(3);
    expect(r.otelClientSpans).toHaveLength(3);
  });

  it.each(['sdk,nock', 'nock,sdk'])('nock (%s)', async (order) => {
    const r = await run(order);
    // no https passthrough call here, see the fixture
    expect(r.results).toEqual([OK, OK, OK, '{"mocked":true}']);
    expect(r.nockDone).toBe(true);
    // mocked calls are counted at most once; the SDK's own flush still reaches the collector
    expect(r.sdkEvents.filter((e) => e.startsWith('/v1/mocked')).length).toBeLessThanOrEqual(1);
    expect(r.sdkEvents).toEqual(
      expect.arrayContaining(ALL_CALLS.filter((c) => !c.startsWith('/v1/https'))),
    );
  });
});
