/**
 * Inbound webhook detection (docs/privacy.md "Inbound webhooks", architecture §3.1).
 *
 * The SDK checks only whether these header NAMES are present on an incoming
 * request; the one VALUE it may read is the send timestamp below, turned into a
 * number at once. Every rule was checked against the provider's own webhook
 * documentation (2026-11-10). Rules are tried in order: more specific
 * combinations first, so a header shared by several senders never decides alone
 * (GitHub is detected by `x-github-event`, not by `x-hub-signature`, which
 * Intercom and Bitbucket send too; GitLab before the generic Standard Webhooks
 * headers it also sends).
 *
 * Not detectable from headers (signature in the body): Adyen, Mailgun. Svix
 * customers (Clerk, Resend, …) all send the same `svix-*` headers, so they are
 * reported as `Svix` unless the route is declared with `webhooks: [{ path, provider }]`.
 */

/** Where the send time is: a header holding a timestamp, or a `key=value` part of one. */
export type WebhookTimestamp =
  /** Unix time; seconds or milliseconds, told apart by size. */
  | { header: string; format: 'epoch' }
  /** ISO 8601 / RFC 3339 (fractional seconds of any length). */
  | { header: string; format: 'iso' }
  /** `key=<unix seconds>` inside a list separated by `separator` (Stripe `t=`, Paddle `ts=`). */
  | { header: string; format: 'part'; key: string; separator: string };

export interface WebhookRule {
  /** Provider name; matches the catalog name where the catalog has the provider. */
  provider: string;
  /** All of these (lower-case) headers must be present. */
  headers: readonly string[];
  /** Send time of this delivery attempt, when the provider signs one. */
  timestamp?: WebhookTimestamp;
}

export const WEBHOOK_RULES: readonly WebhookRule[] = [
  {
    provider: 'Stripe',
    headers: ['stripe-signature'],
    timestamp: { header: 'stripe-signature', format: 'part', key: 't', separator: ',' },
  },
  { provider: 'GitHub', headers: ['x-github-event', 'x-github-delivery'] },
  {
    provider: 'GitLab',
    headers: ['x-gitlab-event'],
    timestamp: { header: 'webhook-timestamp', format: 'epoch' },
  },
  {
    provider: 'Shopify',
    headers: ['x-shopify-topic', 'x-shopify-webhook-id'],
    timestamp: { header: 'x-shopify-triggered-at', format: 'iso' },
  },
  {
    provider: 'Slack',
    headers: ['x-slack-signature', 'x-slack-request-timestamp'],
    timestamp: { header: 'x-slack-request-timestamp', format: 'epoch' },
  },
  {
    provider: 'SendGrid',
    headers: ['x-twilio-email-event-webhook-signature'],
    timestamp: { header: 'x-twilio-email-event-webhook-timestamp', format: 'epoch' },
  },
  { provider: 'Twilio', headers: ['x-twilio-signature'] },
  { provider: 'Checkout.com', headers: ['cko-signature'] },
  {
    provider: 'Paddle',
    headers: ['paddle-signature'],
    timestamp: { header: 'paddle-signature', format: 'part', key: 'ts', separator: ';' },
  },
  {
    provider: 'PayPal',
    headers: ['paypal-transmission-sig', 'paypal-transmission-id'],
    timestamp: { header: 'paypal-transmission-time', format: 'iso' },
  },
  // Square's only timestamp is the *first* delivery's, so a retry would look like lag: none used
  { provider: 'Square', headers: ['x-square-hmacsha256-signature'] },
  {
    provider: 'HubSpot',
    headers: ['x-hubspot-signature-v3'],
    timestamp: { header: 'x-hubspot-request-timestamp', format: 'epoch' },
  },
  { provider: 'HubSpot', headers: ['x-hubspot-signature', 'x-hubspot-signature-version'] },
  {
    provider: 'Zoom',
    headers: ['x-zm-signature', 'x-zm-request-timestamp'],
    timestamp: { header: 'x-zm-request-timestamp', format: 'epoch' },
  },
  {
    provider: 'Twitch',
    headers: ['twitch-eventsub-message-signature'],
    timestamp: { header: 'twitch-eventsub-message-timestamp', format: 'iso' },
  },
  {
    provider: 'Calendly',
    headers: ['calendly-webhook-signature'],
    timestamp: { header: 'calendly-webhook-signature', format: 'part', key: 't', separator: ',' },
  },
  { provider: 'Typeform', headers: ['typeform-signature'] },
  { provider: 'Razorpay', headers: ['x-razorpay-signature'] },
  {
    provider: 'Linear',
    headers: ['linear-signature', 'linear-delivery'],
    timestamp: { header: 'linear-timestamp', format: 'epoch' },
  },
  { provider: 'Vercel', headers: ['x-vercel-signature'] },
  {
    provider: 'Svix',
    headers: ['svix-id', 'svix-signature'],
    timestamp: { header: 'svix-timestamp', format: 'epoch' },
  },
  {
    provider: 'Standard Webhooks',
    headers: ['webhook-id', 'webhook-signature'],
    timestamp: { header: 'webhook-timestamp', format: 'epoch' },
  },
];

/** Every header the SDK may look at for inbound requests (names; values only for timestamps). */
export const WEBHOOK_HEADER_ALLOWLIST: readonly string[] = [
  ...new Set(
    WEBHOOK_RULES.flatMap((r) => [...r.headers, ...(r.timestamp ? [r.timestamp.header] : [])]),
  ),
];

/** Words of webhook routes that are never personal data: kept as-is in inbound templates. */
export const WEBHOOK_PATH_WORDS: readonly string[] = [
  'webhook',
  'webhooks',
  'hook',
  'hooks',
  'callback',
  'callbacks',
  'notify',
  'notification',
  'notifications',
  'events',
  'event',
  'incoming',
  'inbound',
  'ipn',
  'stripe',
  'github',
  'gitlab',
  'shopify',
  'slack',
  'sendgrid',
  'twilio',
  'checkout',
  'cko',
  'paddle',
  'paypal',
  'square',
  'hubspot',
  'zoom',
  'twitch',
  'calendly',
  'typeform',
  'razorpay',
  'linear',
  'vercel',
  'svix',
  'clerk',
  'resend',
  'adyen',
  'mailgun',
];

/** Host placeholder on inbound events: they have no provider host. */
export const INBOUND_HOST = 'inbound';

/** Send timestamps further than this from the receive time are ignored (wrong clock or a replay). */
export const MAX_WEBHOOK_TIMESTAMP_SKEW_MS = 7 * 24 * 3600_000;

const MAX_VALUE_LENGTH = 512;

/** Unix time in seconds or milliseconds (13+ digits) → epoch ms. */
function parseEpoch(s: string): number | undefined {
  const t = s.trim();
  if (!/^\d{9,16}(?:\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1e12 ? Math.round(n) : Math.round(n * 1000);
}

/** ISO 8601 with fractional seconds of any length (Twitch and Shopify send nanoseconds). */
function parseIso(s: string): number | undefined {
  const t = s.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return undefined;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The send time in a header value, as epoch ms; undefined when absent,
 * unparsable or implausible. Only the timestamp is extracted: the rest of a
 * signature header is never looked at beyond finding the key.
 */
export function parseWebhookTimestamp(
  spec: WebhookTimestamp,
  value: unknown,
  now: number,
): number | undefined {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string' || value === '') return undefined;
  const v = value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value;
  let ms: number | undefined;
  if (spec.format === 'epoch') ms = parseEpoch(v);
  else if (spec.format === 'iso') ms = parseIso(v);
  else {
    const prefix = spec.key + '=';
    for (const part of v.split(spec.separator)) {
      const p = part.trim();
      if (p.startsWith(prefix)) {
        ms = parseEpoch(p.slice(prefix.length));
        break;
      }
    }
  }
  if (ms === undefined || Math.abs(now - ms) > MAX_WEBHOOK_TIMESTAMP_SKEW_MS) return undefined;
  return ms;
}

/**
 * The first rule whose headers are all present. `has` answers for one
 * lower-case header name; nothing else about the request is asked.
 */
export function detectWebhook(has: (name: string) => boolean): WebhookRule | undefined {
  for (const r of WEBHOOK_RULES) {
    let all = true;
    for (const h of r.headers) {
      if (!has(h)) {
        all = false;
        break;
      }
    }
    if (all) return r;
  }
  return undefined;
}

/** The first rule for a provider name that carries a timestamp (declared routes). */
export function timestampRuleFor(provider: string): WebhookTimestamp | undefined {
  const lower = provider.toLowerCase();
  return WEBHOOK_RULES.find((r) => r.provider.toLowerCase() === lower && r.timestamp)?.timestamp;
}

// ------------------------------------------------------------ webhook discovery (candidates)

/**
 * Route words that make a POST/PUT a webhook *candidate* wherever they appear
 * as a whole path segment (docs/privacy.md "Webhook discovery"). They are rare
 * as REST resource names.
 */
export const CANDIDATE_ROUTE_WORDS: readonly string[] = [
  'webhook',
  'webhooks',
  'hook',
  'hooks',
  'callback',
  'callbacks',
];

/**
 * Words that are also ordinary REST resources (`POST /api/events`): a
 * candidate only at the end of the path or before one plain name
 * (`/events`, `/events/orbitpay`), and only from a caller that sends no API
 * credentials header.
 */
export const CANDIDATE_WEAK_ROUTE_WORDS: readonly string[] = ['notify', 'notifications', 'events'];

/**
 * Header names that mark a browser or the app's own front end, never a
 * webhook sender: a request carrying any of them is never a candidate.
 */
export const CANDIDATE_CLIENT_HEADERS: readonly string[] = [
  'cookie',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'x-requested-with',
  'x-csrf-token',
  'x-xsrf-token',
];

/** Header names of an API client: they rule out the weak words (an API call, not a delivery). */
export const CANDIDATE_API_CLIENT_HEADERS: readonly string[] = ['authorization', 'x-api-key'];

/** At most this many distinct suggested names per process; after that, `unknown`. */
export const MAX_CANDIDATE_NAMES = 16;

const GENERIC_SIGNATURE = /^(?:x-(?:[a-z0-9-]+-)?signature(?:-256)?|webhook-signature)$/;

/**
 * A generic signature header name: `x-signature`, `x-webhook-signature`,
 * `x-hub-signature(-256)`, `x-<anything>-signature`, `webhook-signature`.
 */
export function isGenericSignatureHeader(name: string): boolean {
  return (
    name.length <= 64 &&
    (name.endsWith('signature') || name.endsWith('signature-256')) &&
    GENERIC_SIGNATURE.test(name)
  );
}

/** A plain lower-case name (letters and inner hyphens, 2–32): never an ID, token or number. */
const NAME_LIKE = /^[a-z](?:[a-z-]{0,30}[a-z])$/;

/** Segments that name a place in the app, not a sender: never suggested. */
const NOT_A_SENDER = new Set([
  ...CANDIDATE_ROUTE_WORDS,
  ...CANDIDATE_WEAK_ROUTE_WORDS,
  'api',
  'apis',
  'rest',
  'public',
  'private',
  'internal',
  'external',
  'app',
  'apps',
  'service',
  'services',
  'integration',
  'integrations',
  'incoming',
  'inbound',
  'in',
  'ingest',
  'receive',
  'receiver',
  'handler',
  'handlers',
  'listener',
  'notification',
  'event',
  'v',
]);

export interface WebhookCandidate {
  /** What made it a candidate. */
  reason: 'route' | 'signature';
  /** Index (in the path's segments) of the segment suggested as the sender's name. */
  nameIndex?: number;
  /** That segment, lower-cased. */
  name?: string;
}

const isSenderName = (seg: string | undefined): seg is string =>
  seg !== undefined && NAME_LIKE.test(seg) && !NOT_A_SENDER.has(seg);

/**
 * Is this incoming request a webhook candidate? Only for POST/PUT; `segs` are
 * the raw path's segments, `has` answers for one lower-case header name and
 * `anyName` tests every header *name* (never a value). Returns undefined for
 * everything else, including any request with browser headers.
 */
export function detectWebhookCandidate(
  method: string,
  segs: readonly string[],
  has: (name: string) => boolean,
  anyName: (test: (name: string) => boolean) => boolean,
): WebhookCandidate | undefined {
  if (method !== 'POST' && method !== 'PUT') return undefined;
  const last = segs.length - 1;
  // route words first: no allocation for ordinary paths (words are 4 to 13 characters)
  let at = -1;
  let weak = false;
  for (let i = 0; i <= last; i++) {
    const raw = segs[i]!;
    if (raw.length < 4 || raw.length > 13) continue;
    const s = raw.toLowerCase();
    if (CANDIDATE_ROUTE_WORDS.includes(s)) {
      at = i;
      weak = false;
      break;
    }
    if (
      at < 0 &&
      CANDIDATE_WEAK_ROUTE_WORDS.includes(s) &&
      (i === last || (i === last - 1 && isSenderName(segs[last]!.toLowerCase())))
    ) {
      at = i;
      weak = true;
    }
  }
  if (at < 0 && !anyName(isGenericSignatureHeader)) return undefined;
  for (const h of CANDIDATE_CLIENT_HEADERS) if (has(h)) return undefined;
  if (at >= 0 && weak && CANDIDATE_API_CLIENT_HEADERS.some(has)) {
    // an API call to an `events`-style resource; only a signature header still makes it one
    return anyName(isGenericSignatureHeader) ? { reason: 'signature' } : undefined;
  }
  if (at < 0) return { reason: 'signature' };
  // the sender's name: the path's last segment after the word, or the one before a final word
  const lastSeg = segs[last]!.toLowerCase();
  if (at < last && isSenderName(lastSeg))
    return { reason: 'route', nameIndex: last, name: lastSeg };
  const before = at > 0 ? segs[at - 1]!.toLowerCase() : undefined;
  if (at === last && isSenderName(before))
    return { reason: 'route', nameIndex: at - 1, name: before };
  return { reason: 'route' };
}
