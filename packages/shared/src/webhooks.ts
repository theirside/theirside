import { isVersionSegment } from './templating.js';

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

/**
 * A signature header NAME (never its value): any name containing `signature` or
 * `hmac` (`x-signature`, `x-hub-signature-256`, `x-hmac-signature-sha-256`,
 * `x-foo-hmac`, `webhook-signature`), at most 64 characters.
 */
export function isSignatureHeaderName(name: string): boolean {
  return name.length <= 64 && (name.includes('signature') || name.includes('hmac'));
}

/** @deprecated Kept for callers of the older, narrower rule; same as isSignatureHeaderName. */
export const isGenericSignatureHeader = isSignatureHeaderName;

/**
 * CloudEvents (cloudevents.io), the vendor-neutral event envelope: binary mode puts
 * the attributes in `ce-*` headers (`ce-specversion` plus `ce-source` or `ce-type`
 * mark one), structured mode sends `content-type: application/cloudevents+json`
 * (or the batch type) with the attributes in the body, which is never read.
 * Of the `ce-*` headers only two VALUES are read: `ce-source` (a suggested name)
 * and `ce-time` (the send time, for delivery lag).
 */
export const CLOUDEVENTS_TIMESTAMP: WebhookTimestamp = { header: 'ce-time', format: 'iso' };

/** Header values webhook discovery may read, and why (docs/privacy.md "Webhook discovery"). */
export const CANDIDATE_VALUE_HEADERS: readonly string[] = [
  // only its first label is compared with the webhook words
  'host',
  // only compared with the CloudEvents structured-mode types
  'content-type',
  // a suggested name: the domain part only
  'ce-source',
  // the send time (deliveries from confirmed or declared routes)
  'ce-time',
];

const STRUCTURED_CE = /^application\/cloudevents(?:-batch)?\+json\b/i;

/** Binary- or structured-mode CloudEvents; `get` is asked only for `content-type`. */
export function isCloudEvent(
  has: (name: string) => boolean,
  get?: (name: string) => unknown,
): boolean {
  if (has('ce-specversion') && (has('ce-source') || has('ce-type'))) return true;
  const ct = get?.('content-type');
  return typeof ct === 'string' && STRUCTURED_CE.test(ct.trim());
}

/**
 * A first label containing a webhook word, followed by a domain (`webhook.example.com`,
 * `hooks-eu.example.com:8443`); a bare name (`localhost`) has no domain behind it.
 */
const WEBHOOK_HOST = /^[^.:]*(?:hook|callback)[^.:]*\./i;

/** The Host's first label names webhooks (only that label is looked at; the port is ignored). */
export function isWebhookHost(host: unknown): boolean {
  if (Array.isArray(host)) host = host[0];
  return typeof host === 'string' && host.length <= 255 && WEBHOOK_HOST.test(host);
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
  // host and URL parts a CloudEvents source may start with
  'www',
  'localhost',
]);

const isSenderName = (seg: string | undefined): seg is string =>
  seg !== undefined && NAME_LIKE.test(seg) && !NOT_A_SENDER.has(seg);

/** Second-level labels under a country code that are public suffixes (`co.uk`, `com.au`). */
const CC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'go']);

/**
 * The registrable label of a host's labels given TLD first (`com.example.payments`
 * reversed, or a hostname's labels reversed): the label after the public suffix,
 * approximated without the public suffix list (the SDK doesn't carry it): one
 * label, or two for `co.uk`-style country suffixes.
 */
function registrableLabel(tldFirst: readonly string[]): string | undefined {
  if (tldFirst.length < 2) return undefined;
  const two = tldFirst[0]!.length === 2 && CC_SECOND_LEVEL.has(tldFirst[1]!);
  return two ? tldFirst[2] : tldFirst[1];
}

const DNS_LABELS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * A sender name from a CloudEvents `ce-source` value: a reverse-DNS id
 * (`com.example.payments` → `example`) or a URL (`https://api.example.com/x/123`
 * → `example`); anything after the domain (paths, IDs) is ignored, and a source
 * without a domain (`/sensors/12`, a URN) gives none. Only a plain name is returned.
 */
export function nameFromCloudEventsSource(source: unknown): string | undefined {
  if (Array.isArray(source)) source = source[0];
  if (typeof source !== 'string' || source === '' || source.length > 512) return undefined;
  const v = source.trim().toLowerCase();
  let host: string | undefined;
  let reverse = false;
  const url = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)/.exec(v);
  if (url) host = url[1]!.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  else {
    // reverse-DNS, possibly followed by a path or an id (`com.example/orders/1`, `com.example:1`)
    const id = /^([a-z0-9.-]+)/.exec(v)?.[1];
    if (id && id.includes('.')) {
      host = id;
      reverse = true;
    }
  }
  if (!host || !DNS_LABELS.test(host) || /^\d+(?:\.\d+)*$/.test(host)) return undefined;
  const labels = host.split('.');
  const name = registrableLabel(reverse ? labels : [...labels].reverse());
  return isSenderName(name) ? name : undefined;
}

/** What made a request a webhook candidate (several may hold at once). */
export type CandidateSignal =
  'route word' | 'weak route word' | 'signature header' | 'cloudevents' | 'webhook host';

export interface WebhookCandidate {
  /** The strongest signal (`route`: a route word; kept for older callers). */
  reason: 'route' | 'signature' | 'cloudevents' | 'host';
  /** Every signal that held. */
  signals: CandidateSignal[];
  /** Index (in the path's segments) of the segment suggested as the sender's name, if it comes from the path. */
  nameIndex?: number;
  /** The suggested sender name, lower-cased. */
  name?: string;
  /** Where the name came from. */
  nameFrom?: 'ce-source' | 'route' | 'path';
}

/** Why a request is not a candidate (for THEIRSIDE_DEBUG=inbound; names only, never values). */
export type CandidateDecision =
  { candidate: WebhookCandidate; ignored?: undefined } | { candidate?: undefined; ignored: string };

/** The common answer, shared (no allocation for an ordinary POST). */
const NOT_A_CANDIDATE: CandidateDecision = Object.freeze({ ignored: 'no webhook signal' });

/** Cheap pre-check before splitting a path: could it hold a route word at all? */
const MAYBE_ROUTE_WORD = /hook|callback|notif|event/i;

export interface CandidateRequest {
  method: string;
  /** The raw path (no query string), or its segments. */
  path: string | readonly string[];
  /** Is this (lower-case) header present? */
  has(name: string): boolean;
  /** Tests every (lower-case) header NAME. */
  anyName(test: (name: string) => boolean): boolean;
  /** One header's value; asked only for `CANDIDATE_VALUE_HEADERS`. */
  get?(name: string): unknown;
}

/**
 * Webhook discovery (docs/privacy.md "Webhook discovery"): is this incoming
 * request a delivery from a sender the SDK can't identify? Only POST/PUT, never
 * with a browser header. Signals: a route word (`/webhooks/…`; the weak words
 * `events`, `notify`, `notifications` only at the end and without API
 * credentials), a signature header name, CloudEvents headers, or a webhook host.
 * The same function decides for every entry path (a Node server, each kind of
 * Lambda HTTP event), from the same normalised view of the request.
 */
export function classifyWebhookCandidate(req: CandidateRequest): CandidateDecision {
  const { method, has, anyName } = req;
  if (method !== 'POST' && method !== 'PUT')
    return { ignored: `${method}: discovery looks only at POST and PUT` };
  let segsCache: readonly string[] | undefined;
  const segs = () =>
    (segsCache ??=
      typeof req.path === 'string' ? req.path.split('/').filter((x) => x !== '') : req.path);
  // route words (no split for ordinary paths: words are 4 to 13 characters)
  let at = -1;
  let weak = false;
  if (typeof req.path !== 'string' || MAYBE_ROUTE_WORD.test(req.path)) {
    const ss = segs();
    const last = ss.length - 1;
    for (let i = 0; i <= last; i++) {
      const raw = ss[i]!;
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
        (i === last || (i === last - 1 && isSenderName(ss[last]!.toLowerCase())))
      ) {
        at = i;
        weak = true;
      }
    }
  }
  // a weak word with API credentials is an API call to an `events`-style resource
  const cred = at >= 0 && weak ? CANDIDATE_API_CLIENT_HEADERS.find(has) : undefined;
  const routeCounts = at >= 0 && !cred;
  const signature = anyName(isSignatureHeaderName);
  const ce = isCloudEvent(has, req.get);
  const host = req.get !== undefined && isWebhookHost(req.get('host'));
  if (!routeCounts && !signature && !ce && !host)
    return cred
      ? { ignored: `weak route word with API credentials (${cred} header)` }
      : NOT_A_CANDIDATE;
  for (const h of CANDIDATE_CLIENT_HEADERS)
    if (has(h)) return { ignored: `browser or front-end request (${h} header)` };
  const signals: CandidateSignal[] = [];
  if (routeCounts) signals.push(weak ? 'weak route word' : 'route word');
  if (signature) signals.push('signature header');
  if (ce) signals.push('cloudevents');
  if (host) signals.push('webhook host');

  const reason: WebhookCandidate['reason'] = routeCounts
    ? 'route'
    : signature
      ? 'signature'
      : ce
        ? 'cloudevents'
        : 'host';
  const c: WebhookCandidate = { reason, signals };

  // the sender's name: CloudEvents source, then the route word's neighbour, then the
  // segment after a version segment
  const fromSource = ce ? nameFromCloudEventsSource(req.get?.('ce-source')) : undefined;
  if (fromSource) return { candidate: { ...c, name: fromSource, nameFrom: 'ce-source' } };
  const ss = segs();
  const last = ss.length - 1;
  if (routeCounts) {
    const lastSeg = ss[last]!.toLowerCase();
    if (at < last && isSenderName(lastSeg))
      return { candidate: { ...c, nameIndex: last, name: lastSeg, nameFrom: 'route' } };
    const before = at > 0 ? ss[at - 1]!.toLowerCase() : undefined;
    if (at === last && isSenderName(before))
      return { candidate: { ...c, nameIndex: at - 1, name: before, nameFrom: 'route' } };
  }
  if (last >= 1) {
    const lastSeg = ss[last]!.toLowerCase();
    const version = ss.findIndex((x, i) => i < last && isVersionSegment(x));
    if (version >= 0 && isSenderName(lastSeg))
      return { candidate: { ...c, nameIndex: last, name: lastSeg, nameFrom: 'path' } };
  }
  return { candidate: c };
}

/**
 * Is this incoming request a webhook candidate? (`classifyWebhookCandidate`
 * without the reason when it isn't.) `get` reads only `CANDIDATE_VALUE_HEADERS`.
 */
export function detectWebhookCandidate(
  method: string,
  path: string | readonly string[],
  has: (name: string) => boolean,
  anyName: (test: (name: string) => boolean) => boolean,
  get?: (name: string) => unknown,
): WebhookCandidate | undefined {
  return classifyWebhookCandidate({ method, path, has, anyName, ...(get ? { get } : {}) })
    .candidate;
}
