// Child-process scenario: apply instrumentations in the order given on argv,
// make calls through every client, print what each tool saw as JSON.
// Usage: coexist.cts <step,step,...> where steps are sdk | xray | otel | nock
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

const order = (process.argv[2] ?? 'sdk').split(',');

async function main() {
  const { startCollector, startProvider, startHttpsProvider } = require('../helpers.ts');
  const collector = await startCollector();
  const provider = await startProvider();
  const tls = await startHttpsProvider();

  let xraySegment: { subsegments?: { name: string }[] } | undefined;
  let AWSXRay: typeof import('aws-xray-sdk-core') | undefined;
  let otelExporter: { getFinishedSpans(): ReadableSpan[] } | undefined;
  let nockScope: { isDone(): boolean } | undefined;

  for (const step of order) {
    if (step === 'sdk') {
      require('../../src/index.ts').init(
        {
          apiKey: 'k',
          endpoint: collector.url,
          flushIntervalMs: 60_000,
          providers: [
            { name: 'Local', hosts: ['localhost'] },
            { name: 'Mocked', hosts: ['api.mocked.test'] },
          ],
          handleProcessExit: false,
          // capture is under test here, not the path privacy rules
          pathPrivacy: 'balanced',
        },
        { minPathSightings: 1 },
      );
    } else if (step === 'xray') {
      AWSXRay = require('aws-xray-sdk-core') as typeof import('aws-xray-sdk-core');
      AWSXRay.setContextMissingStrategy('IGNORE_ERROR');
      AWSXRay.setLogger({ error() {}, warn() {}, info() {}, debug() {} });
      AWSXRay.captureHTTPsGlobal(require('node:http'));
      AWSXRay.captureHTTPsGlobal(require('node:https'));
    } else if (step === 'otel') {
      const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
      const {
        InMemorySpanExporter,
        SimpleSpanProcessor,
      } = require('@opentelemetry/sdk-trace-base');
      const { registerInstrumentations } = require('@opentelemetry/instrumentation');
      const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
      otelExporter = new InMemorySpanExporter();
      const tp = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(otelExporter)],
      });
      tp.register();
      registerInstrumentations({ instrumentations: [new HttpInstrumentation()] });
      // require-in-the-middle patches on the next require of the core modules
      require('node:http');
      require('node:https');
      require('http');
      require('https');
    } else if (step === 'nock') {
      const nockModule = require('nock');
      const nock = nockModule.default ?? nockModule.nock ?? nockModule;
      nockScope = nock('http://api.mocked.test').get('/v1/mocked').reply(200, { mocked: true });
    }
  }

  const http = require('node:http') as typeof import('node:http');
  const https = require('node:https') as typeof import('node:https');
  const axios = require('axios') as import('axios').AxiosStatic;

  const get = (mod: typeof http | typeof https, url: string, opts = {}) =>
    new Promise<string>((resolve, reject) => {
      mod
        .get(url, opts, (res) => {
          let b = '';
          res.on('data', (c: Buffer) => (b += c));
          res.on('end', () => resolve(b));
        })
        .on('error', reject);
    });

  const calls = async () => {
    const results: string[] = [];
    results.push(await get(http, `${provider.url}/v1/http`));
    // nock 14 breaks real TLS passthrough on Node 24 (independent of this SDK; nock 15
    // fixes it but needs Node 22+), so the nock scenarios skip the https call
    if (!nockScope) results.push(await get(https, `${tls.url}/v1/https`, { ca: tls.cert }));
    results.push(await (await fetch(`${provider.url}/v1/fetch`)).text());
    results.push(
      JSON.stringify((await axios.get(`${provider.url}/v1/axios`, { adapter: 'http' })).data),
    );
    if (nockScope) results.push(await get(http, 'http://api.mocked.test/v1/mocked'));
    return results;
  };

  let results: string[];
  if (AWSXRay) {
    const segment = new AWSXRay.Segment('coexist-test');
    xraySegment = segment as unknown as typeof xraySegment;
    const ns = AWSXRay.getNamespace();
    results = await ns.runAndReturn(() => {
      AWSXRay!.setSegment(segment);
      return calls();
    });
  } else {
    results = await calls();
  }

  const sdk = require('../../src/index.ts');
  await sdk.flush();
  const events = collector.events();

  const out = {
    results,
    sdkEvents: events
      .map((e: { endpoint: string; outcome: string }) => `${e.endpoint} ${e.outcome}`)
      .sort(),
    xraySubsegments: xraySegment?.subsegments?.map((s) => s.name).sort() ?? null,
    otelClientSpans: otelExporter
      ? otelExporter
          .getFinishedSpans()
          .filter((s) => s.kind === 2)
          .map((s) => String(s.attributes['url.path'] ?? s.attributes['http.target'] ?? s.name))
          .sort()
      : null,
    nockDone: nockScope ? nockScope.isDone() : null,
  };
  await sdk.shutdown(200);
  await Promise.all([collector.close(), provider.close(), tls.close()]);
  process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
  process.exit(0);
}

main().catch((err) => {
  process.stdout.write('ERROR ' + String(err?.stack ?? err) + '\n');
  process.exit(1);
});
