/**
 * Load generator.
 *   MODE=direct  calls the chaos provider's fake APIs itself, instrumented by the SDK
 *   MODE=demo    calls the NestJS demo app (examples/nestjs-demo), which calls the providers
 * Env: RPS (default 20), CHAOS_PORT (4010), DEMO_URL, THEIRSIDE_COLLECTOR_URL, THEIRSIDE_API_KEY;
 *      THEIRSIDE_ADMIN_TOKEN + SINK_URL (+ SINK_SECRET) also configure the demo (setup.ts).
 */
import { init, shutdown } from '@theirside/sdk';
import { setupDemo } from './setup.js';
import { fakeProviders, startDemoTraffic, startDirectTraffic } from './traffic.js';

const mode = process.env.MODE ?? 'direct';
const rps = Number(process.env.RPS ?? 20);

if (mode === 'direct') {
  init({
    apiKey: process.env.THEIRSIDE_API_KEY,
    endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
    service: 'loadgen',
    environment: process.env.THEIRSIDE_ENVIRONMENT ?? 'demo',
    // zero-config: the collector discovers and groups the fake providers
    debug: true,
  });
}

const traffic =
  mode === 'demo'
    ? startDemoTraffic(process.env.DEMO_URL ?? 'http://localhost:3000', rps)
    : startDirectTraffic(fakeProviders(Number(process.env.CHAOS_PORT ?? 4010)), rps);

console.log(`loadgen: mode=${mode} rps=${rps}`);

// Demo convenience: alert channel into the chaos sink, provider support contacts, public names.
if (process.env.THEIRSIDE_ADMIN_TOKEN && process.env.SINK_URL) {
  setupDemo({
    collector: process.env.THEIRSIDE_COLLECTOR_URL ?? 'http://collector:4318',
    adminToken: process.env.THEIRSIDE_ADMIN_TOKEN,
    sinkUrl: process.env.SINK_URL,
    sinkSecret: process.env.SINK_SECRET ?? 'e2e-sink-secret-0123456789',
  }).catch((err) => console.error(`setup failed: ${(err as Error).message}`));
}
const report = setInterval(() => {
  console.log(`loadgen: ${traffic.stats.calls} calls, ${traffic.stats.failures} failed`);
}, 30_000);

const stop = async () => {
  clearInterval(report);
  traffic.stop();
  await shutdown();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
