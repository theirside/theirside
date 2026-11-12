import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_HEADER_ALLOWLIST,
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
