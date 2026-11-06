import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundledCatalog, Catalog, emptyHistogram, groupHost, OUTCOMES } from '@theirside/shared';
import {
  CATALOG_CHANGES,
  catalogBefore,
  catalogRegroupJob,
  isUnedited,
} from '../src/modules/discovery/regroup.js';
import type { ProviderInput, Tenant } from '../src/storage/types.js';
import { FakeClock } from '../src/util/clock.js';
import { batch, event, ingestRequest, startTestApp, type TestApp } from './helpers.js';

const START = Date.UTC(2026, 10, 6, 9, 0);
const catalog = new Catalog();
const previous = catalogBefore(bundledCatalog(), CATALOG_CHANGES[0]!.domains);

describe('catalog change 0.2.3', () => {
  it('lists only domains the bundled catalog has, and each moves a host to a new provider', () => {
    const all = new Set(bundledCatalog().flatMap((e) => e.domains));
    for (const d of CATALOG_CHANGES[0]!.domains) expect(all, d).toContain(d);
  });

  it.each([
    ['places.googleapis.com', 'Google Cloud', 'Google Maps Platform'],
    ['us-central1-aiplatform.googleapis.com', 'Google Cloud', 'Google Cloud AI APIs'],
    ['email.eu-west-1.amazonaws.com', 'AWS', 'Amazon SES'],
    ['acme.openai.azure.com', 'Microsoft Azure', 'Azure OpenAI'],
    ['challenges.cloudflare.com', 'Cloudflare', 'Cloudflare Turnstile'],
    ['maps.googleapis.com', 'Google Maps Platform', 'Google Maps Platform'],
    ['storage.googleapis.com', 'Google Cloud', 'Google Cloud'],
  ])('%s: %s before, %s now', (host, before, now) => {
    expect(groupHost(host, previous).name).toBe(before);
    expect(groupHost(host, catalog).name).toBe(now);
  });
});

let t: TestApp;
const MIN = 60_000;

/** One project per scenario. */
async function project(id: string): Promise<Tenant> {
  await t.db.storage.config.createProject(t.orgId, id, id);
  return { orgId: t.orgId, projectId: id };
}

/** A provider as 0.2.2's directory created it. */
const AUTO: Record<string, Partial<ProviderInput> & { category: string }> = {
  'Google Cloud': { category: 'infrastructure', domain: 'googleapis.com', alertsEnabled: false },
  AWS: { category: 'infrastructure', domain: 'amazonaws.com', alertsEnabled: false },
  'Microsoft Azure': { category: 'infrastructure', domain: 'azure.com', alertsEnabled: false },
};
async function provider(
  tenant: Tenant,
  name: string,
  hosts: string[],
  extra: Partial<ProviderInput> = {},
) {
  const auto = AUTO[name] ?? { category: 'other', domain: name, alertsEnabled: true };
  return t.db.storage.config.upsertProvider(tenant, {
    name,
    hostPatterns: [],
    explicitRoutes: [],
    supportEmail: null,
    supportUrl: null,
    supportNotes: null,
    publicDisplayName: null,
    isPublic: false,
    source: AUTO[name] ? 'catalog' : 'discovered',
    hosts,
    ...auto,
    ...extra,
  } as ProviderInput);
}
async function calls(tenant: Tenant, providerName: string, n: number) {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<
    (typeof OUTCOMES)[number],
    number
  >;
  await t.db.storage.rollups.upsert(tenant, [
    {
      environment: 'production',
      provider: providerName,
      endpoint: '/v1/places:searchText',
      method: 'POST',
      minute: new Date(START - 60 * MIN).toISOString(),
      total: n,
      ok: n,
      outcomes: { ...outcomes, ok: n },
      status429: 0,
      latencyHistogram: emptyHistogram(),
      latencySumMs: n * 100,
    },
  ]);
}
const byName = async (tenant: Tenant) =>
  Object.fromEntries(
    (await t.db.storage.config.listProviders(tenant)).map((p) => [p.name, p] as const),
  );
const rollupsOf = async (tenant: Tenant) =>
  Object.fromEntries(
    (
      await t.db.pool.query(
        `SELECT provider, sum(total)::int AS n FROM rollups_1m WHERE project_id = $1 GROUP BY provider`,
        [tenant.projectId],
      )
    ).rows.map((r) => [r.provider, r.n]),
  );

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(START) });
});
afterAll(async () => t.close());

describe('re-grouping existing installs', () => {
  const s: Record<string, Tenant> = {};

  beforeAll(async () => {
    // A: only Maps hosts under Google Cloud, with history
    s.whole = await project('prj_whole');
    await provider(s.whole, 'Google Cloud', [
      'places.googleapis.com',
      'addressvalidation.googleapis.com',
    ]);
    await calls(s.whole, 'Google Cloud', 40);
    // B: Maps and storage under Google Cloud
    s.partial = await project('prj_partial');
    await provider(s.partial, 'Google Cloud', ['places.googleapis.com', 'storage.googleapis.com']);
    await calls(s.partial, 'Google Cloud', 30);
    // C: renamed in the dashboard
    s.edited = await project('prj_edited');
    await provider(s.edited, 'Google Cloud', ['places.googleapis.com'], { displayName: 'GCP' });
    // D: a person merged the Maps host into their own provider
    s.manual = await project('prj_manual');
    await provider(s.manual, 'acme.test', ['api.acme.test', 'places.googleapis.com']);
    // E: AWS with SES and SQS; F: Azure with only Azure OpenAI
    s.aws = await project('prj_aws');
    await provider(s.aws, 'AWS', ['email.eu-west-1.amazonaws.com', 'sqs.eu-west-1.amazonaws.com']);
    s.azure = await project('prj_azure');
    await provider(s.azure, 'Microsoft Azure', ['acme.openai.azure.com']);
    await calls(s.azure, 'Microsoft Azure', 5);
    // G: alerts switched on for Google Cloud by hand
    s.alerts = await project('prj_alerts');
    await provider(s.alerts, 'Google Cloud', ['places.googleapis.com'], { alertsEnabled: true });

    await catalogRegroupJob(t.db.storage, catalog).run(new Date(START));
  });

  it('merges a provider whose hosts all move, history included', async () => {
    const p = await byName(s.whole!);
    expect(p['Google Cloud']).toBeUndefined();
    expect(p['Google Maps Platform']).toMatchObject({
      category: 'maps',
      alertsEnabled: true,
      source: 'catalog',
    });
    expect([...p['Google Maps Platform']!.hosts].sort()).toEqual([
      'addressvalidation.googleapis.com',
      'places.googleapis.com',
    ]);
    expect(await rollupsOf(s.whole!)).toEqual({ 'Google Maps Platform': 40 });
  });

  it('moves only the hosts when the provider keeps others; history stays', async () => {
    const p = await byName(s.partial!);
    expect(p['Google Cloud']!.hosts).toEqual(['storage.googleapis.com']);
    expect(p['Google Cloud']).toMatchObject({ category: 'infrastructure', alertsEnabled: false });
    expect(p['Google Maps Platform']!.hosts).toEqual(['places.googleapis.com']);
    expect(await rollupsOf(s.partial!)).toEqual({ 'Google Cloud': 30 });
  });

  it('leaves edited providers and manual merges alone', async () => {
    expect(Object.keys(await byName(s.edited!))).toEqual(['Google Cloud']);
    expect(Object.keys(await byName(s.alerts!))).toEqual(['Google Cloud']);
    const manual = await byName(s.manual!);
    expect(Object.keys(manual)).toEqual(['acme.test']);
    expect(manual['acme.test']!.hosts).toContain('places.googleapis.com');
  });

  it('applies to AWS and Azure end-user APIs too', async () => {
    const aws = await byName(s.aws!);
    expect(aws.AWS!.hosts).toEqual(['sqs.eu-west-1.amazonaws.com']);
    expect(aws['Amazon SES']).toMatchObject({ category: 'email', alertsEnabled: true });
    const azure = await byName(s.azure!);
    expect(Object.keys(azure)).toEqual(['Azure OpenAI']);
    expect(await rollupsOf(s.azure!)).toEqual({ 'Azure OpenAI': 5 });
  });

  it('runs once per install', async () => {
    await provider(s.edited!, 'AWS', ['email.us-east-1.amazonaws.com']);
    await catalogRegroupJob(t.db.storage, catalog).run(new Date(START + MIN));
    expect(Object.keys(await byName(s.edited!)).sort()).toEqual(['AWS', 'Google Cloud']);
  });

  it('isUnedited: what counts as a change', () => {
    const base = {
      source: 'catalog',
      name: 'Google Cloud',
      category: 'infrastructure',
      domain: 'googleapis.com',
      displayName: null,
      publicDisplayName: null,
      isPublic: false,
      hidden: false,
      internal: false,
      alertsEnabled: false,
      supportEmail: null,
      supportUrl: null,
      supportNotes: null,
      pathPrivacy: null,
      allowedPathWords: [],
      explicitRoutes: [],
      hostPatterns: ['*.googleapis.com'],
    } as unknown as Parameters<typeof isUnedited>[0];
    expect(isUnedited(base)).toBe(true);
    for (const change of [
      { source: 'configured' },
      { displayName: 'GCP' },
      { alertsEnabled: true },
      { hidden: true },
      { supportEmail: 'x@y.test' },
      { pathPrivacy: 'balanced' },
      { allowedPathWords: ['x'] },
      { explicitRoutes: ['/x'] },
      { hostPatterns: ['*.example.test'] },
      { isPublic: true },
    ])
      expect(isUnedited({ ...base, ...change } as typeof base), JSON.stringify(change)).toBe(false);
  });
});

describe('directory: a folded pattern never swallows a more specific catalog provider', () => {
  it('places.googleapis.com under a folded *.googleapis.com goes to Google Maps Platform', async () => {
    const tenant = { orgId: t.orgId, projectId: t.projectId };
    await provider(tenant, 'Google Cloud', ['storage.googleapis.com'], {
      hostPatterns: ['*.googleapis.com'],
    });
    t.ctx.directory.invalidate();
    const hosts = ['places.googleapis.com', 'bigquery.googleapis.com', 'fcm.googleapis.com'];
    const res = await t.app.inject(
      ingestRequest(
        batch(hosts.map((host) => event({ ts: START, provider: null, host, endpoint: '/v1/x' }))),
      ),
    );
    expect(res.statusCode).toBe(202);
    const p = await byName(tenant);
    expect(p['Google Maps Platform']!.hosts).toEqual(['places.googleapis.com']);
    expect(p['Firebase Cloud Messaging']!.hosts).toEqual(['fcm.googleapis.com']);
    // not more specific: stays with the fold
    expect(p['Google Cloud']!.hosts).toEqual(['storage.googleapis.com']);
    const r = await rollupsOf(tenant);
    expect(r).toMatchObject({
      'Google Maps Platform': 1,
      'Firebase Cloud Messaging': 1,
      'Google Cloud': 1,
    });
  });
});
