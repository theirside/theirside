import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Catalog,
  bundledCatalog,
  exclusionReason,
  groupHost,
  registrableDomain,
  RouteLearner,
  EndpointTemplater,
  compileRoute,
  type CatalogEntry,
  type PathPolicy,
} from '../src/index.js';

/** tools/vocabulary/names.txt: common first and last names from many countries (CC0). */
const NAMES = readFileSync(new URL('../../../tools/vocabulary/names.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'));
/** Names that are also ordinary API words, so they stay in the vocabulary (docs/privacy.md). */
const NAME_COLLISIONS = [
  'ai',
  'long',
  'mark',
  'max',
  'min',
  'or',
  'price',
  'run',
  'sim',
  'to',
  'uri',
];

describe('exclusionReason', () => {
  it.each([
    // loopback
    ['localhost', 'loopback'],
    ['LOCALHOST', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.10.20.30', 'loopback'],
    ['0.0.0.0', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    // private / link-local IPv4
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.20', 'private'],
    ['169.254.10.10', 'private'],
    ['100.64.0.1', 'private'],
    ['::ffff:10.1.2.3', 'private'],
    // private IPv6
    ['fe80::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fc00::1', 'private'],
    // cloud metadata
    ['169.254.169.254', 'metadata'],
    ['169.254.170.2', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['[fd00:ec2::254]', 'metadata'],
    ['metadata.google.internal', 'metadata'],
    // internal names
    ['users-service', 'internal-name'],
    ['redis', 'internal-name'],
    ['api.localhost', 'internal-name'],
    ['printer.local', 'internal-name'],
    ['ledger.svc.cluster.local', 'internal-name'],
    ['ip-10-0-0-1.ec2.internal', 'internal-name'],
    ['billing.corp', 'internal-name'],
    ['nas.home.arpa', 'internal-name'],
    // telemetry
    ['o123456.ingest.sentry.io', 'telemetry'],
    ['sentry.io', 'telemetry'],
    ['http-intake.logs.datadoghq.com', 'telemetry'],
    ['trace.agent.datadoghq.eu', 'telemetry'],
    ['log-api.newrelic.com', 'telemetry'],
    ['otlp.nr-data.net', 'telemetry'],
    ['api.honeycomb.io', 'telemetry'],
    ['xray.eu-west-1.amazonaws.com', 'telemetry'],
    // providers: recorded
    ['api.stripe.com', null],
    ['api.acmecards.test', null],
    ['8.8.8.8', null],
    ['172.32.0.1', null],
    ['2606:4700::1111', null],
    ['s3.eu-west-1.amazonaws.com', null],
    ['notsentry.io', null],
    ['sentry.io.example.com', null],
  ])('%s → %s', (host, reason) => {
    expect(exclusionReason(host)).toBe(reason);
  });
});

describe('registrableDomain (Public Suffix List)', () => {
  it.each([
    ['api.acmecards.com', 'acmecards.com'],
    ['files.acmecards.com', 'acmecards.com'],
    ['sandbox.acmecards.com', 'acmecards.com'],
    ['api.acmecards.co.uk', 'acmecards.co.uk'],
    ['t57.saasco.test', 'saasco.test'],
    ['deep.sub.domain.example.org', 'example.org'],
    // private suffixes: each tenant app is its own provider
    ['myapp.herokuapp.com', 'myapp.herokuapp.com'],
    ['shop.myshopify.com', 'shop.myshopify.com'],
    // unknown TLD: default rule (last label is the suffix)
    ['x.y.unknowntld', 'y.unknowntld'],
    ['8.8.8.8', '8.8.8.8'],
  ])('%s → %s', (host, domain) => {
    expect(registrableDomain(host)).toBe(domain);
  });
});

describe('catalog', () => {
  const catalog = new Catalog();

  it('ships a sane bundled catalog', () => {
    const entries = bundledCatalog();
    expect(entries.length).toBeGreaterThanOrEqual(150);
    const names = entries.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    const domains = entries.flatMap((e) => e.domains);
    expect(new Set(domains).size).toBe(domains.length);
    for (const e of entries) {
      expect(e.domains.length).toBeGreaterThan(0);
      // `*` stands for part of one label (a region), never in the last label
      for (const d of e.domains) expect(d).toMatch(/^[a-z0-9*-]+(\.[a-z0-9*-]+)*\.[a-z]{2,}$/);
      // unverified contacts are never shipped
      expect(e.supportEmail).toBeNull();
      expect(e.supportUrl).toBeNull();
    }
  });

  it.each([
    ['api.stripe.com', 'Stripe', 'payments'],
    ['files.stripe.com', 'Stripe', 'payments'],
    ['production.plaid.com', 'Plaid', 'banking'],
    ['api.openai.com', 'OpenAI', 'ai'],
    ['api.postmarkapp.com', 'Postmark', 'email'],
    ['my-bucket.s3.eu-west-1.amazonaws.com', 'AWS', 'infrastructure'],
    ['fcm.googleapis.com', 'Firebase Cloud Messaging', 'messaging'],
    ['www.googleapis.com', 'Google Cloud', 'infrastructure'],
    ['maps.googleapis.com', 'Google Maps Platform', 'maps'],
    // end-user APIs of the big clouds: providers, not infrastructure
    ['places.googleapis.com', 'Google Maps Platform', 'maps'],
    ['addressvalidation.googleapis.com', 'Google Maps Platform', 'maps'],
    ['routes.googleapis.com', 'Google Maps Platform', 'maps'],
    ['roads.googleapis.com', 'Google Maps Platform', 'maps'],
    ['generativelanguage.googleapis.com', 'Google Gemini API', 'ai'],
    ['us-central1-aiplatform.googleapis.com', 'Google Cloud AI APIs', 'ai'],
    ['translation.googleapis.com', 'Google Cloud AI APIs', 'ai'],
    ['recaptchaenterprise.googleapis.com', 'reCAPTCHA Enterprise', 'auth'],
    ['androidpublisher.googleapis.com', 'Google Play Developer API', 'commerce'],
    ['storage.googleapis.com', 'Google Cloud', 'infrastructure'],
    ['pubsub.googleapis.com', 'Google Cloud', 'infrastructure'],
    ['bigquery.googleapis.com', 'Google Cloud', 'infrastructure'],
    ['email.eu-west-1.amazonaws.com', 'Amazon SES', 'email'],
    ['bedrock-runtime.us-east-1.amazonaws.com', 'Amazon Bedrock', 'ai'],
    ['cognito-idp.eu-central-1.amazonaws.com', 'Amazon Cognito', 'auth'],
    ['places.geo.us-east-1.amazonaws.com', 'Amazon Location Service', 'maps'],
    ['sms-voice.ap-southeast-2.amazonaws.com', 'AWS End User Messaging', 'messaging'],
    ['sqs.us-east-1.amazonaws.com', 'AWS', 'infrastructure'],
    ['dynamodb.us-east-1.amazonaws.com', 'AWS', 'infrastructure'],
    ['email.amazonaws.com', 'AWS', 'infrastructure'], // no region label: not SES's shape
    ['acme.openai.azure.com', 'Azure OpenAI', 'ai'],
    ['acme.cognitiveservices.azure.com', 'Azure AI services', 'ai'],
    ['acme.communication.azure.com', 'Azure Communication Services', 'messaging'],
    ['acme.blob.core.windows.net', 'Microsoft Azure', 'infrastructure'],
    ['atlas.microsoft.com', 'Azure Maps', 'maps'],
    ['challenges.cloudflare.com', 'Cloudflare Turnstile', 'auth'],
    ['api.cloudflare.com', 'Cloudflare', 'infrastructure'],
  ])('%s → %s (%s)', (host, name, category) => {
    expect(groupHost(host, catalog)).toMatchObject({ name, category, source: 'catalog' });
  });

  it('a wildcard match reports the matched part of the host as the domain', () => {
    expect(groupHost('email.eu-west-1.amazonaws.com', catalog).domain).toBe(
      'email.eu-west-1.amazonaws.com',
    );
    expect(groupHost('x.email.eu-west-1.amazonaws.com', catalog).name).toBe('Amazon SES');
  });

  it('falls back to the registrable domain', () => {
    expect(groupHost('api.acmecards.test', catalog)).toEqual({
      name: 'acmecards.test',
      domain: 'acmecards.test',
      category: 'other',
      source: 'discovered',
      catalog: null,
    });
  });

  it('extra entries (test override) add catalog names', () => {
    const extra: CatalogEntry[] = [
      {
        name: 'NotifyCo',
        category: 'messaging',
        domains: ['notifyco.test'],
        supportEmail: null,
        supportUrl: null,
      },
    ];
    expect(groupHost('api.notifyco.test', new Catalog(undefined, extra))).toMatchObject({
      name: 'NotifyCo',
      source: 'catalog',
      category: 'messaging',
    });
  });
});

describe('RouteLearner', () => {
  const names = (n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`,
    );

  const BALANCED: PathPolicy = { privacy: 'balanced' };

  /** Calls the same path n times, returns the last template. */
  const repeat = (
    t: EndpointTemplater,
    host: string,
    path: string,
    n: number,
    policy?: PathPolicy,
  ) => {
    let out = '';
    for (let i = 0; i < n; i++) out = t.template(host, path, undefined, policy);
    return out;
  };

  it.each([
    ['/customers/john-smith/cards', '/customers/:id/cards', '/:id/:id/:id'],
    ['/v1/customers/maria/cards', '/v1/customers/:id/cards', '/v1/:id/:id/:id'],
    ['/v2/users/jose-garcia', '/v2/users/:id', '/v2/:id/:id'],
    ['/people/o%27brien/addresses/home', '/people/:id/addresses/home', '/:id/:id/:id/:id'],
    ['/v1/accounts/Anna.Kowalska/balance', '/v1/accounts/:id/balance', '/v1/:id/:id/:id'],
    ['/v1/ledger/:id/john_smith', '/v1/ledger/:id/:id', '/v1/:id/:id/:id'],
  ])(
    'first sight of %s: strict sends known words only, balanced nothing',
    (path, strict, balanced) => {
      const t = new EndpointTemplater({ learner: new RouteLearner() });
      expect(t.template('api.x.test', path)).toBe(strict);
      expect(t.template('api.y.test', path, undefined, BALANCED)).toBe(balanced);
    },
  );

  it('a name is never sent while each value is seen fewer than 5 times', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner() });
    // warm up the resource names; the name position stays unconfirmed
    for (let i = 0; i < 5; i++) t.template('api.x.test', `/customers/${names(5)[i]}/cards`);
    const seen: string[] = [];
    for (const n of ['john-smith', 'maria', 'ivan-petrenko', 'li-wei'])
      for (let i = 0; i < 4; i++) seen.push(t.template('api.x.test', `/customers/${n}/cards`));
    expect(seen.every((x) => x.startsWith('/customers/:id/'))).toBe(true);
    expect(seen.at(-1)).toBe('/customers/:id/cards');
    expect(seen.join(' ')).not.toMatch(/john|maria|ivan|wei/);
  });

  it('balanced: a literal goes out as-is from its 5th sighting at that host and position', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner() });
    const out = Array.from({ length: 6 }, () =>
      t.template('api.x.test', '/v1/transfers', undefined, BALANCED),
    );
    expect(out).toEqual([
      '/v1/:id',
      '/v1/:id',
      '/v1/:id',
      '/v1/:id',
      '/v1/transfers',
      '/v1/transfers',
    ]);
    // per host: another host starts from zero
    expect(t.template('api.other.test', '/v1/transfers', undefined, BALANCED)).toBe('/v1/:id');
    // deeper segments count under the templated parent
    expect(repeat(t, 'api.x.test', '/v1/transfers/pending', 4, BALANCED)).toBe('/v1/transfers/:id');
    expect(t.template('api.x.test', '/v1/transfers/pending', undefined, BALANCED)).toBe(
      '/v1/transfers/pending',
    );
    // strict sends known words from the first call
    expect(t.template('api.new.test', '/v1/transfers/pending')).toBe('/v1/transfers/pending');
  });

  it('a policy key makes several hosts learn as one (a provider)', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner() });
    const p: PathPolicy = { privacy: 'balanced', key: '@p:Acme' };
    for (const h of ['api.acme.test', 'files.acme.test', 'eu.acme.test', 'api.acme.test'])
      expect(t.template(h, '/v1/transfers', undefined, p)).toBe('/v1/:id');
    expect(t.template('files.acme.test', '/v1/transfers', undefined, p)).toBe('/v1/transfers');
  });

  it('version segments are exempt; ID-shaped segments never count', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner() });
    expect(t.template('api.x.test', '/v2.1/cards/4111111111111111', undefined, BALANCED)).toBe(
      '/v2.1/:id/:id',
    );
    expect(repeat(t, 'api.x.test', '/v2.1/cards/4111111111111111', 5, BALANCED)).toBe(
      '/v2.1/cards/:id',
    );
    expect(t.template('api.y.test', '/v2.1/cards/4111111111111111')).toBe('/v2.1/cards/:id');
  });

  it('balanced: collapses a letters-only ID position after more than 16 distinct values', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner() });
    repeat(t, 'api.x.test', '/v1/accounts', 5, BALANCED);
    // each value seen 5 times: the first 16 confirm, the 17th distinct one makes it :id
    const seen = names(24).map((n) =>
      repeat(t, 'api.x.test', `/v1/accounts/${n}/balance`, 5, BALANCED),
    );
    expect(seen[0]).toBe(`/v1/accounts/${names(1)[0]}/:id`); // balance still unconfirmed here
    expect(new Set(seen.slice(0, 16).map((s) => s.split('/')[3])).size).toBe(16);
    expect(seen[16]).toBe('/v1/accounts/:id/balance');
    expect(seen.slice(17).every((s) => s === '/v1/accounts/:id/balance')).toBe(true);
    // also for values confirmed before learning (cache dropped)
    expect(
      t.template('api.x.test', `/v1/accounts/${names(1)[0]}/balance`, undefined, BALANCED),
    ).toBe('/v1/accounts/:id/balance');
  });

  it('keeps resource names and learns per host and parent', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner() });
    for (const r of ['customers', 'charges', 'refunds', 'payouts'])
      expect(repeat(t, 'api.x.test', `/v1/${r}`, 5)).toBe(`/v1/${r}`);
    repeat(t, 'api.x.test', '/v1/accounts', 5, BALANCED);
    for (const n of names(20)) repeat(t, 'api.x.test', `/v1/accounts/${n}`, 5, BALANCED);
    expect(t.template('api.x.test', `/v1/accounts/${names(1)[0]}`, undefined, BALANCED)).toBe(
      '/v1/accounts/:id',
    );
    repeat(t, 'api.other.test', '/v1/accounts', 5, BALANCED);
    expect(repeat(t, 'api.other.test', `/v1/accounts/${names(1)[0]}`, 5, BALANCED)).toBe(
      `/v1/accounts/${names(1)[0]}`,
    );
    expect(t.template('api.x.test', '/v1/customers')).toBe('/v1/customers');
  });

  it('minSightings is configurable (1 = previous behaviour)', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner({ minSightings: 1 }) });
    expect(t.template('api.x.test', '/v1/customers/john-smith', undefined, BALANCED)).toBe(
      '/v1/customers/john-smith',
    );
    expect(t.template('api.x.test', '/v1/customers/john-smith')).toBe('/v1/customers/:id');
  });

  describe('strict path privacy (default): only vocabulary words go out', () => {
    it.each([
      ['/v2/people/ivan-wei', '/v2/people/:id'],
      ['/people/olga', '/people/:id'],
      ['/v1/customers/john-smith/cards', '/v1/customers/:id/cards'],
      ['/customers/cus_8f2KdL3x/cards', '/customers/:id/cards'],
      ['/customers/123/payment-methods', '/customers/:id/payment-methods'],
      ['/orders/77/line_items', '/orders/:id/line_items'],
      ['/shipments/9910/tracking', '/shipments/:id/tracking'],
      ['/v1/chat/completions', '/v1/chat/completions'],
      ['/messages/42/attachments', '/messages/:id/attachments'],
      ['/v1/users/me/bulkUpdate', '/v1/users/me/bulkUpdate'],
      ['/products/blue-running-shoes', '/products/:id'],
      ['/v1/accounts/Anna.Kowalska/balance', '/v1/accounts/:id/balance'],
    ])('%s → %s (however often called)', (path, expected) => {
      const t = new EndpointTemplater({ learner: new RouteLearner() });
      // called 50 times: the 5 sightings are long passed, a lone name is never confirmed
      expect(repeat(t, 'api.x.test', path, 50)).toBe(expected);
    });

    it('a name called very often by itself is still :id (the soak leak)', () => {
      const t = new EndpointTemplater({ learner: new RouteLearner() });
      const out = new Set<string>();
      for (let i = 0; i < 1000; i++)
        for (const n of ['ivan-wei', 'olga-silva', 'li'])
          out.add(t.template('api.x.test', `/v2/people/${n}`));
      expect([...out].join(' ')).not.toMatch(/ivan|olga|silva|\/li\b/);
    });

    it('a provider’s allowed words go out as-is', () => {
      const t = new EndpointTemplater({ learner: new RouteLearner() });
      const policy: PathPolicy = { privacy: 'strict', allowedWords: new Set(['sneakers']) };
      expect(repeat(t, 'api.x.test', '/v1/sneakers/blue', 5, policy)).toBe('/v1/sneakers/:id');
      expect(repeat(t, 'api.x.test', '/v1/sneakers', 5)).toBe('/v1/:id'); // other providers don't have it
    });

    it('balanced: word slugs go out until the position has more than 16 values', () => {
      const t = new EndpointTemplater({ learner: new RouteLearner() });
      repeat(t, 'api.x.test', '/products', 5, BALANCED);
      const slugs = Array.from({ length: 20 }, (_, i) => `blue-running-shoes-${names(20)[i]}`);
      const out = slugs.map((s) => repeat(t, 'api.x.test', `/products/${s}`, 5, BALANCED));
      expect(out[15]).toBe(`/products/${slugs[15]}`);
      expect(out.slice(16)).toEqual(Array(4).fill('/products/:id'));
    });

    it('names list: only names that are also ordinary API words are ever sent', () => {
      // every name alone at typical positions, called 10 times each: the worst case
      const sent = new Set<string>();
      const positions = (n: string) => [`/v1/customers/${n}`, `/people/${n}/cards`, `/v1/${n}`];
      for (const n of NAMES) {
        const t = new EndpointTemplater({ learner: new RouteLearner() });
        for (const p of positions(n))
          for (let i = 0; i < 10; i++)
            if (t.template('api.x.test', p).split('/').includes(n)) sent.add(n);
      }
      // the documented collisions (docs/privacy.md), nothing else
      expect([...sent].sort()).toEqual(NAME_COLLISIONS);
    });
  });

  it('explicit routes win over learning', () => {
    const t = new EndpointTemplater({ learner: new RouteLearner({ maxValuesPerSlot: 2 }) });
    const routes = [compileRoute('/v1/users/:userId')];
    for (const n of names(10))
      expect(t.template('h', `/v1/users/${n}`, routes)).toBe('/v1/users/:userId');
  });

  it('memory stays within the caps under unbounded hosts and paths', () => {
    const learner = new RouteLearner();
    const t = new EndpointTemplater({ learner });
    for (let i = 0; i < 100_000; i++) {
      const host = `t${i % 5000}.saasco.test`;
      t.template(host, `/v1/${names(1)[0]}${i % 997}x/items/${i.toString(36)}abc`);
    }
    const s = learner.size();
    expect(s.slots).toBeLessThanOrEqual(learner.maxSlots);
    expect(s.values).toBeLessThanOrEqual(learner.maxSlots * (learner.maxValuesPerSlot + 1));
    expect(s.learned).toBeLessThanOrEqual(learner.maxLearned);
    expect(t.hostCount()).toBeLessThanOrEqual(500);
  });
});

describe('RouteLearner under many tenant subdomains (overnight soak)', () => {
  // the soak's 2,500 names (25 × 25 × 4); a pool of ~100 would see a few names
  // pass 5 sightings before 33 distinct ones, the documented limit (docs/privacy.md)
  const FIRST =
    'anna ivan maria john li omar sara pablo yuki emma noah olga raj chen ada leo mia tom eva kai ines jan zoe max ali'.split(
      ' ',
    );
  const LAST =
    'smith kowalska garcia petrenko wei haddad berg silva tanaka brown novak shah olsen costa meyer rossi khan dubois lopez kim moreau young evans hill ward'.split(
      ' ',
    );
  const name = (r: () => number) =>
    `${FIRST[Math.floor(r() * 25)]}-${LAST[Math.floor(r() * 25)]}${Math.floor(r() * 4) || ''}`;
  /** Seeded PRNG (mulberry32), so each host sees a spread of names like real traffic. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const PATHS = [
    (n: number) => `/v1/cards/${100000 + n}/activate`,
    () => '/v1/accounts',
    (_: number, r: () => number) => `/v1/customers/${name(r)}/cards`,
    (_: number, r: () => number) => `/v2/people/${name(r)}`,
    (n: number) => `/v1/verifications/${n}/documents`,
  ];
  // 20 vendors × 3 subdomains: below the fold threshold, each host learns on its own
  const vendors = Array.from(
    { length: 60 },
    (_, i) => `${['api', 'files', 'sandbox'][i % 3]}.vendor${i % 20}.test`,
  );

  /**
   * The overnight soak's mix: 1 in 4 calls goes to one of 5,000 tenant
   * subdomains, the rest to the 60 vendor hosts. Reports, after warm-up, the
   * share of vendor `/cards` calls not filed under `/v1/customers/:id/cards`.
   */
  function soak(t: EndpointTemplater, calls = 300_000) {
    const r = rng(42);
    let total = 0;
    let misfiled = 0;
    const outputs = new Set<string>();
    for (let n = 0; n < calls; n++) {
      const vendor = vendors[Math.floor(n / PATHS.length) % 60]!;
      const host = r() < 0.25 ? `t${Math.floor(r() * 5000)}.saasco.test` : vendor;
      const path = PATHS[n % PATHS.length]!(n, r);
      const out = t.template(host, path);
      outputs.add(out);
      if (host !== vendor || !path.endsWith('/cards') || n < 50_000) continue;
      total++;
      if (out !== '/v1/customers/:id/cards') misfiled++;
    }
    return { share: misfiled / total, total, outputs };
  }

  it('vendor hosts keep their sighting counts while tenant subdomains stream in', () => {
    const learner = new RouteLearner();
    const { share, total, outputs } = soak(new EndpointTemplater({ learner }));
    expect(total).toBeGreaterThan(10_000);
    expect(share).toBe(0);
    for (const v of vendors)
      expect(learner.sightings(v, '/v1/customers/:id', 3, 'cards')).toBe(learner.minSightings);
    // the tenants learned together, and no name ever went out
    expect(learner.sightings('*.saasco.test', '/v1/customers/:id', 3, 'cards')).toBe(5);
    expect([...outputs].filter((o) => FIRST.some((f) => o.includes(f + '-')))).toEqual([]);
  });

  it('keys 20+ subdomains of one domain as *.domain, like the collector folds them', () => {
    const learner = new RouteLearner();
    for (let i = 0; i < 19; i++)
      expect(learner.keyFor(`t${i}.saasco.test`)).toBe(`t${i}.saasco.test`);
    expect(learner.keyFor('t19.saasco.test')).toBe('*.saasco.test');
    // earlier subdomains move over too; ports stay part of the key
    expect(learner.keyFor('t0.saasco.test')).toBe('*.saasco.test');
    expect(learner.keyFor('t7.saasco.test:8443')).toBe('*.saasco.test:8443');
    // a vendor's few subdomains, apex domains, IPs and single labels keep their own keys
    for (const h of [
      'api.vendor1.test',
      'files.vendor1.test',
      'vendor1.test',
      '10.0.0.7',
      'localhost',
    ])
      expect(learner.keyFor(h)).toBe(h);
    // repeat calls to the same subdomain don't count as new ones
    const other = new RouteLearner();
    for (let i = 0; i < 100; i++) other.keyFor('api.acme.test');
    expect(other.keyFor('eu.acme.test')).toBe('eu.acme.test');
  });

  it('uses the tenant patterns from the remote config right away', () => {
    const learner = new RouteLearner();
    learner.setTenantPatterns(['*.saasco.test', 'api.vendor.test', '*.eu.big.test:8443']);
    expect(learner.keyFor('t1.saasco.test')).toBe('*.saasco.test');
    expect(learner.keyFor('a.b.saasco.test')).toBe('*.saasco.test');
    expect(learner.keyFor('saasco.test')).toBe('saasco.test');
    expect(learner.keyFor('api.vendor.test')).toBe('api.vendor.test'); // not a wildcard
    expect(learner.keyFor('x.eu.big.test')).toBe('*.eu.big.test');
    const t = new EndpointTemplater({ learner });
    for (let i = 0; i < 5; i++) t.template(`t${i}.saasco.test`, '/v1/accounts');
    expect(t.template('t99.saasco.test', '/v1/accounts')).toBe('/v1/accounts');
  });

  it('evicts the least-used slots first, so a busy host keeps its counts through a flood', () => {
    const learner = new RouteLearner();
    const t = new EndpointTemplater({ learner });
    for (let i = 0; i < 5; i++) t.template('api.busy.test', '/v1/transfers/pending');
    // 20,000 one-off hosts on distinct domains (nothing to fold), the busy host called in between
    for (let i = 0; i < 20_000; i++) {
      t.template(`api.d${i}.test`, `/v1/x${i % 7}a/y`);
      if (i % 50 === 0) t.template('api.busy.test', '/v1/transfers/pending');
    }
    expect(learner.sightings('api.busy.test', '/v1', 1, 'transfers')).toBe(5);
    expect(learner.sightings('api.busy.test', '/v1/transfers', 2, 'pending')).toBe(5);
    expect(t.template('api.busy.test', '/v1/transfers/pending')).toBe('/v1/transfers/pending');
  });

  it('memory stays bounded under unbounded domains, subdomains and paths', () => {
    const learner = new RouteLearner();
    const t = new EndpointTemplater({ learner });
    for (let i = 0; i < 200_000; i++) {
      // new domains with < 20 subdomains each, folding domains, and remote tenant churn
      const host = i % 3 === 0 ? `s${i % 13}.d${i}.test` : `t${i}.fold${i % 3000}.test:${i % 5}`;
      t.template(host, `/v1/w${i % 997}x/items/${i.toString(36)}abc`);
      if (i % 50_000 === 0)
        learner.setTenantPatterns(Array.from({ length: 2000 }, (_, k) => `*.r${k + i}.test`));
    }
    const s = learner.size();
    expect(s.slots).toBeLessThanOrEqual(learner.maxSlots);
    expect(s.values).toBeLessThanOrEqual(learner.maxSlots * (learner.maxValuesPerSlot + 1));
    expect(s.learned).toBeLessThanOrEqual(learner.maxLearned);
    expect(s.domains).toBeLessThanOrEqual(learner.maxDomains);
    expect(s.labels).toBeLessThanOrEqual(learner.maxDomains * learner.foldSubdomainsAt);
    expect(s.folded).toBeLessThanOrEqual(learner.maxDomains);
    expect(s.keys).toBeLessThanOrEqual(2000);
  });
});
