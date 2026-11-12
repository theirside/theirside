import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_HEADER_ALLOWLIST,
  CANDIDATE_VALUE_HEADERS,
  classifyWebhookCandidate,
  isCloudEvent,
  isSignatureHeaderName,
  isWebhookHost,
  nameFromCloudEventsSource,
  WEBHOOK_RULES,
  detectWebhook,
  parseWebhookTimestamp,
  type WebhookTimestamp,
} from '../src/webhooks.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const T = Math.floor(NOW / 1000) - 3;

const detect = (headers: string[]) => detectWebhook((h) => headers.includes(h))?.provider;

describe('detectWebhook', () => {
  it.each([
    [['stripe-signature'], 'Stripe'],
    [['x-github-event', 'x-github-delivery', 'x-hub-signature-256'], 'GitHub'],
    // GitHub without a secret: no signature header at all
    [['x-github-event', 'x-github-delivery'], 'GitHub'],
    // GitLab also sends the Standard Webhooks headers: GitLab wins
    [['x-gitlab-event', 'webhook-id', 'webhook-signature', 'webhook-timestamp'], 'GitLab'],
    [['webhook-id', 'webhook-signature', 'webhook-timestamp'], 'Standard Webhooks'],
    [['svix-id', 'svix-signature', 'svix-timestamp'], 'Svix'],
    [['x-shopify-topic', 'x-shopify-webhook-id', 'x-shopify-hmac-sha256'], 'Shopify'],
    [['x-slack-signature', 'x-slack-request-timestamp'], 'Slack'],
    [['x-twilio-signature'], 'Twilio'],
    // SendGrid's header starts with x-twilio- too, but differs
    [['x-twilio-email-event-webhook-signature'], 'SendGrid'],
    [['cko-signature'], 'Checkout.com'],
    [['paddle-signature'], 'Paddle'],
    [['paypal-transmission-sig', 'paypal-transmission-id'], 'PayPal'],
    [['x-square-hmacsha256-signature'], 'Square'],
    [['x-hubspot-signature-v3'], 'HubSpot'],
    [['x-hubspot-signature', 'x-hubspot-signature-version'], 'HubSpot'],
    [['x-zm-signature', 'x-zm-request-timestamp'], 'Zoom'],
    [['twitch-eventsub-message-signature'], 'Twitch'],
    [['calendly-webhook-signature'], 'Calendly'],
    [['typeform-signature'], 'Typeform'],
    [['x-razorpay-signature'], 'Razorpay'],
    [['linear-signature', 'linear-delivery'], 'Linear'],
    [['x-vercel-signature'], 'Vercel'],
  ])('%j → %s', (headers, provider) => {
    expect(detect(headers)).toBe(provider);
  });

  it.each([
    // shared by Intercom, Bitbucket and GitHub's legacy header: never decides alone
    [['x-hub-signature']],
    // a half combination
    [['webhook-id']],
    [['x-github-delivery']],
    // ordinary traffic
    [['authorization', 'content-type', 'user-agent']],
    [[]],
  ])('%j → nothing', (headers) => {
    expect(detect(headers)).toBeUndefined();
  });

  it('allowlist holds every header a rule reads, nothing else', () => {
    const fromRules = new Set(
      WEBHOOK_RULES.flatMap((r) => [...r.headers, ...(r.timestamp ? [r.timestamp.header] : [])]),
    );
    expect(new Set(WEBHOOK_HEADER_ALLOWLIST)).toEqual(fromRules);
    for (const h of WEBHOOK_HEADER_ALLOWLIST) {
      expect(h).toBe(h.toLowerCase());
      expect(h).not.toMatch(/^(authorization|cookie|x-api-key)$/);
    }
  });
});

describe('parseWebhookTimestamp', () => {
  const stripe: WebhookTimestamp = {
    header: 'stripe-signature',
    format: 'part',
    key: 't',
    separator: ',',
  };
  const paddle: WebhookTimestamp = {
    header: 'paddle-signature',
    format: 'part',
    key: 'ts',
    separator: ';',
  };
  const epoch: WebhookTimestamp = { header: 'svix-timestamp', format: 'epoch' };
  const iso: WebhookTimestamp = { header: 'x-shopify-triggered-at', format: 'iso' };

  it.each<[WebhookTimestamp, unknown, number | undefined]>([
    [
      stripe,
      `t=${T},v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd`,
      T * 1000,
    ],
    [stripe, `v1=abc, t=${T}`, T * 1000],
    [stripe, 'v1=abc', undefined],
    [stripe, 't=notanumber,v1=abc', undefined],
    [
      paddle,
      `ts=${T};h1=eb4d0dc8853be92b7f063b9f3ba5233eb920a09459b6e6b2c26705b4364db151`,
      T * 1000,
    ],
    [epoch, String(T), T * 1000],
    // HubSpot and Linear send milliseconds
    [epoch, String(T * 1000 + 250), T * 1000 + 250],
    [epoch, ' 12 ', undefined],
    [epoch, [String(T), 'ignored'], T * 1000],
    // nanoseconds (Twitch, Shopify)
    [iso, '2026-11-10T11:59:57.123456789Z', Date.parse('2026-11-10T11:59:57.123Z')],
    [iso, '2026-11-10T11:59:57Z', Date.parse('2026-11-10T11:59:57Z')],
    [iso, '2026-11-10T13:59:57+02:00', Date.parse('2026-11-10T11:59:57Z')],
    [iso, 'yesterday', undefined],
    // a clock or replay more than a week off is ignored
    [epoch, String(T - 8 * 24 * 3600), undefined],
    [epoch, String(T + 8 * 24 * 3600), undefined],
    [epoch, undefined, undefined],
    [epoch, '', undefined],
    [epoch, 42, undefined],
  ])('%j %j', (spec, value, expected) => {
    expect(parseWebhookTimestamp(spec, value, NOW)).toBe(expected);
  });

  it('never reads past 512 characters of a header', () => {
    const long = 'v1=' + 'a'.repeat(600) + `,t=${T}`;
    expect(parseWebhookTimestamp(stripe, long, NOW)).toBeUndefined();
  });
});

describe('webhook discovery signals (generic, names made up)', () => {
  it.each([
    ['com.orbitpay', 'orbitpay'],
    ['com.orbitpay.payments', 'orbitpay'],
    ['io.lumenmeter.readings/v1', 'lumenmeter'],
    ['uk.co.parcelcat', 'parcelcat'],
    ['https://api.lumenmeter.test/sources/42', 'lumenmeter'],
    ['https://events.parcelcat.co.uk', 'parcelcat'],
    ['//orbitpay.test/a/b?x=1', 'orbitpay'],
    ['https://user@hooks.orbitpay.test:8443/x', 'orbitpay'],
    ['/sensors/tn-1234', undefined],
    ['urn:uuid:6e8bc430-9c3a-11d9-9669-0800200c9a66', undefined],
    ['https://10.0.0.7/x', undefined],
    ['com.a1b2c3d4e5', undefined],
    ['', undefined],
  ])('ce-source %j → %s', (source, name) => {
    expect(nameFromCloudEventsSource(source)).toBe(name);
  });

  it.each([
    ['x-hmac-signature-sha-256', true],
    ['x-signature-256', true],
    ['x-foo-hmac', true],
    ['webhook-signature', true],
    ['x-signature-version', true],
    ['authorization', false],
    ['x-api-key', false],
    ['content-type', false],
  ])('signature header name %s → %s', (name, yes) => {
    expect(isSignatureHeaderName(name)).toBe(yes);
  });

  it.each([
    ['webhook.shop.test', true],
    ['webhooks.shop.test', true],
    ['hooks-eu.shop.test:8443', true],
    ['callback.shop.test', true],
    ['api.shop.test', false],
    ['shop.test', false],
    ['api.webhooks.shop.test', false],
    ['localhost:3000', false],
  ])('host %s → webhook host %s', (host, yes) => {
    expect(isWebhookHost(host)).toBe(yes);
  });

  it('CloudEvents: binary mode needs specversion plus source or type; structured mode by content type', () => {
    const has = (names: string[]) => (n: string) => names.includes(n);
    expect(isCloudEvent(has(['ce-specversion', 'ce-source']))).toBe(true);
    expect(isCloudEvent(has(['ce-specversion', 'ce-type']))).toBe(true);
    expect(isCloudEvent(has(['ce-specversion']))).toBe(false);
    expect(isCloudEvent(has(['ce-source', 'ce-type']))).toBe(false);
    const ct = (v: string) => (n: string) => (n === 'content-type' ? v : undefined);
    expect(isCloudEvent(has([]), ct('application/cloudevents+json; charset=utf-8'))).toBe(true);
    expect(isCloudEvent(has([]), ct('application/cloudevents-batch+json'))).toBe(true);
    expect(isCloudEvent(has([]), ct('application/json'))).toBe(false);
  });

  it('only the documented header values are ever asked for', () => {
    const asked = new Set<string>();
    classifyWebhookCandidate({
      method: 'POST',
      path: '/v1/orbitpay',
      has: () => true,
      anyName: () => true,
      get: (n) => {
        asked.add(n);
        return n === 'ce-source' ? 'com.orbitpay' : 'x';
      },
    });
    for (const n of asked) expect(CANDIDATE_VALUE_HEADERS).toContain(n);
  });

  it('the name comes from ce-source first, then a route word, then the segment after a version', () => {
    const req = (path: string, headers: Record<string, string>) =>
      classifyWebhookCandidate({
        method: 'POST',
        path,
        has: (n) => n in headers,
        anyName: (t) => Object.keys(headers).some(t),
        get: (n) => headers[n],
      }).candidate;
    const ce = { 'ce-specversion': '1.0', 'ce-source': 'com.orbitpay' };
    expect(req('/webhooks/zephyr', ce)).toMatchObject({ name: 'orbitpay', nameFrom: 'ce-source' });
    expect(req('/webhooks/zephyr', { 'x-signature': 'v' })).toMatchObject({
      name: 'zephyr',
      nameFrom: 'route',
    });
    expect(req('/api/v1/zephyr', { 'x-signature': 'v' })).toMatchObject({
      name: 'zephyr',
      nameFrom: 'path',
    });
    expect(req('/api/zephyr', { 'x-signature': 'v' })?.name).toBeUndefined();
    expect(req('/v1/9f3b2c1a77d0', { 'x-signature': 'v' })?.name).toBeUndefined();
  });

  it('a plain lower-case word after a version or next to a route word is kept, whatever names the sender', () => {
    const req = (path: string, headers: Record<string, string>) =>
      classifyWebhookCandidate({
        method: 'POST',
        path,
        has: (n) => n in headers,
        anyName: (t) => Object.keys(headers).some(t),
        get: (n) => headers[n],
      }).candidate;
    const ce = { 'ce-specversion': '1.0', 'ce-source': 'com.orbitpay' };
    // the name from ce-source, the path word kept: /v1/inbox stays /v1/inbox
    expect(req('/v1/inbox', ce)).toMatchObject({
      name: 'orbitpay',
      nameFrom: 'ce-source',
      nameIndex: 1,
      pathName: 'inbox',
    });
    expect(req('/webhooks/zephyr', ce)).toMatchObject({
      name: 'orbitpay',
      nameIndex: 1,
      pathName: 'zephyr',
    });
    expect(req('/api/v2/zephyr', { 'x-signature': 'v' })).toMatchObject({
      nameIndex: 2,
      pathName: 'zephyr',
    });
    // only a plain lower-case name as sent: never an ID, a mixed-case token or a generic word
    for (const path of ['/v1/Zephyr', '/v1/zephyr2', '/v1/9f3b2c1a77d0', '/v1/inbound', '/v1/x'])
      expect(req(path, ce)).not.toHaveProperty('pathName');
    // no version segment before it, no route word: nothing kept
    expect(req('/api/zephyr', ce)).not.toHaveProperty('pathName');
  });
});
