/**
 * Loaded first by main.ts, before NestJS or any HTTP client is imported.
 * 1. Theirside SDK: zero-config. No provider list: every third-party host the
 *    app calls is discovered and grouped by the collector; the internal ledger
 *    service and the telemetry endpoint are excluded automatically.
 * 2. AWS X-Ray captureHTTPsGlobal, like the production service it mirrors,
 *    to prove the two coexist. No AWS needed: segments go to a local UDP stub.
 */
import { init } from '@theirside/sdk';
import { ClsServiceManager } from 'nestjs-cls';
import { startXRay } from './xray';

/** All fake providers are the chaos provider under different names (docker network aliases). */
export const PROVIDER_URLS = {
  acme: process.env.ACME_URL ?? 'http://api.acmecards.test:4010',
  acmeFiles: process.env.ACME_FILES_URL ?? 'http://files.acmecards.test:4010',
  acmeSandbox: process.env.ACME_SANDBOX_URL ?? 'http://sandbox.acmecards.test:4010',
  kyc: process.env.KYC_URL ?? 'http://api.kyco.test:4010',
  bank: process.env.BANK_URL ?? 'http://api.bankco.test:4010',
  notify: process.env.NOTIFY_URL ?? 'http://api.notifyco.test:4010',
  /** Not in the demo's seeded history: shows up on its own as "New" once traffic starts. */
  geo: process.env.GEO_URL ?? 'http://api.geoapi.test:4010',
  /** Tenant-style subdomains t1…t200.saasco.test (resolved to the chaos provider in providers.ts). */
  saasco: process.env.SAASCO_DOMAIN ?? 'saasco.test',
  saascoPort: Number(process.env.SAASCO_PORT ?? 4010),
  saascoTarget: process.env.SAASCO_TARGET ?? 'chaos',
  /** The team's own service (single-label name): never recorded. */
  ledger: process.env.LEDGER_URL ?? 'http://ledger:4010',
  /** Error tracking ingest: never recorded. */
  telemetry: process.env.TELEMETRY_URL ?? 'http://o4501.ingest.sentry.io:4010',
};

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  service: 'nestjs-demo',
  environment: process.env.THEIRSIDE_ENVIRONMENT ?? 'demo',
  // nestjs-cls request id, set per incoming request (see app.module.ts)
  getCorrelationId: () => ClsServiceManager.getClsService()?.getId(),
  debug: process.env.THEIRSIDE_DEBUG === '1',
});

startXRay();
