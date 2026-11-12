import type { AnyIncidentKind } from '../../storage/types.js';
import { createHmac } from 'node:crypto';
import type { SmtpConfig } from '../../config.js';
import type { AlertChannelRecord } from '../../storage/types.js';
import { createMailTransport, SMTP_TIMEOUT_MS } from '../mail/mailer.js';
import { renderEmail, renderSlack } from './render.js';

/** What every channel receives. Built once per alert, stored on the delivery. */
export interface AlertPayload {
  event: 'open' | 'escalation' | 'resolve' | 'test' | 'discovery';
  /** One line, e.g. "Acme Cards: POST /v2/cards/:id/activate failing (38%)". */
  title: string;
  incidentId: string | null;
  provider: string;
  environment: string;
  status: 'open' | 'resolved' | 'test';
  /**
   * null for test alerts. errors (5xx/network), latency, auth (401/403),
   * not_found (404), validation (400/409/422), rate_limited (429), behaviour;
   * inbound webhooks: webhook_silence, webhook_rejections, webhook_slow, webhook_lag.
   */
  kind?: AnyIncidentKind | null;
  /** `inbound`: about webhooks our app receives from the provider (missing: outgoing calls). */
  direction?: 'outbound' | 'inbound';
  endpoints: {
    method: string;
    endpoint: string;
    /** Share of calls failing the incident's way (5xx/network errors, 401/403, 404…). */
    errorRate: number | null;
    /** The normal share of that. */
    normalErrorRate: number | null;
    p95Ms?: number | null;
    normalP95Ms?: number | null;
  }[];
  /** Other endpoints of the same provider are fine. */
  otherEndpointsOk: boolean;
  otherEndpointsText: string;
  /** Paste-ready text for the provider's support. */
  summary: string;
  /** Dashboard link; null when THEIRSIDE_PUBLIC_URL is not set. */
  url: string | null;
  /**
   * Status-class incidents (401/403, 404, 400/409/422) while open: the dashboard page to
   * mark that status as expected for the endpoint (the coarse level; marking in code is
   * more precise). Null otherwise or without THEIRSIDE_PUBLIC_URL.
   */
  markExpectedUrl?: string | null;
  openedAt: string | null;
  resolvedAt: string | null;
  /** Minutes since opened (or until resolved). */
  durationMinutes?: number | null;
  /** The provider's support contact from provider settings. */
  support?: { email: string | null; url: string | null } | null;
  /** event 'discovery': providers first seen since the last digest. */
  discovered?: {
    name: string;
    label: string;
    category: string | null;
    hosts: string[];
    alertsEnabled: boolean;
  }[];
  /** rate/latency doubled, another endpoint joined (spread), or a stronger kind took over (kind). */
  escalation?: 'rate' | 'latency' | 'spread' | 'kind';
  /** Inbound only: what the webhook alert is based on. */
  webhook?: {
    /** Latest delivery seen (silence). */
    lastDeliveryAt: string | null;
    /** Minutes without a delivery (silence). */
    silentMinutes: number | null;
    /** Normal deliveries per hour at this time of week (silence). */
    expectedPerHour: number | null;
    /** P(no delivery in the gap) under the learned rate (silence). */
    pValue: number | null;
    /** Share of deliveries answered 401/403 (rejections). */
    authShare: number | null;
    /** p95 delivery lag and its normal, seconds (lag). */
    lagP95S: number | null;
    normalLagP95S: number | null;
  };
  /** A restart or deploy of the calling services around the start, or that there was none. */
  deployHint?: string | null;
  /** Side signals: call volume far above normal, failures far faster than normal responses. */
  signals?: string[];
}

/** Channel adapters plug in here (ee/ adds paging integrations the same way). */
export interface ChannelAdapter {
  kind: AlertChannelRecord['kind'];
  /** Throws on failure; the dispatcher retries. */
  send(
    channel: AlertChannelRecord,
    payload: AlertPayload,
    ctx: { deliveryId: string },
  ): Promise<void>;
  /** Returns an error message for an invalid config, else null. */
  validate(config: Record<string, unknown>): string | null;
}

const TIMEOUT_MS = SMTP_TIMEOUT_MS;

/**
 * Turns a failed delivery into a message an operator can act on: the "Send
 * test alert" button shows it as is, and it is stored on the delivery row.
 */
export function describeSendError(err: unknown): string {
  const e = err as {
    name?: string;
    code?: string;
    message?: string;
    response?: string;
    responseCode?: number;
    cause?: { code?: string; message?: string };
  };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return `timed out after ${TIMEOUT_MS / 1000} s`;
  // fetch: TypeError('fetch failed') with the socket error as cause
  if (e?.cause?.code) return `connection failed (${e.cause.code}): ${e.cause.message ?? ''}`.trim();
  // nodemailer
  switch (e?.code) {
    case 'EAUTH':
      return `SMTP authentication failed: ${e.response ?? e.message}`;
    case 'EENVELOPE':
      return `SMTP server rejected the sender or recipients: ${e.response ?? e.message}`;
    case 'EMESSAGE':
      return `SMTP server rejected the message: ${e.response ?? e.message}`;
    case 'ETLS':
      return `SMTP TLS failed: ${e.message}`;
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'ETIMEDOUT':
    case 'EDNS':
      return `SMTP connection failed (${e.code}): ${e.message}`;
  }
  return String(e?.message ?? err);
}

export class HttpStatusError extends Error {}

async function postJson(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'theirside-collector',
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(describeSendError(err), { cause: err });
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // Slack answers 4xx with a reason in the body: invalid_token, no_service, channel_not_found…
    const detail = text.trim().slice(0, 300);
    throw new HttpStatusError(
      `HTTP ${res.status} from ${new URL(url).host}${detail ? `: ${detail}` : ''}`,
    );
  }
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Slack incoming webhook with Block Kit. Config: { webhookUrl }. */
export const slackAdapter: ChannelAdapter = {
  kind: 'slack',
  validate: (c) => (isHttpUrl(c.webhookUrl) ? null : 'webhookUrl must be an http(s) URL'),
  async send(channel, p) {
    await postJson(String(channel.config.webhookUrl), JSON.stringify(renderSlack(p)));
  },
};

/** Generic webhook, HMAC-SHA256 signed. Config: { url, secret }. */
export const webhookAdapter: ChannelAdapter = {
  kind: 'webhook',
  validate: (c) =>
    !isHttpUrl(c.url)
      ? 'url must be an http(s) URL'
      : typeof c.secret !== 'string' || c.secret.length < 16
        ? 'secret must be at least 16 characters'
        : null,
  async send(channel, p, ctx) {
    const body = JSON.stringify(p);
    const ts = Math.floor(Date.now() / 1000);
    await postJson(String(channel.config.url), body, {
      'x-theirside-event': p.event,
      'x-theirside-delivery': ctx.deliveryId,
      'x-theirside-signature': signWebhook(String(channel.config.secret), ts, body),
    });
  },
};

/**
 * `x-theirside-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * Receivers recompute it and reject old timestamps.
 */
export function signWebhook(secret: string, ts: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}

/** Email over SMTP (THEIRSIDE_SMTP_URL or THEIRSIDE_SMTP_HOST etc.). Config: { to: string[] }. */
export function emailAdapter(smtp: SmtpConfig | undefined): ChannelAdapter {
  const transport = createMailTransport(smtp);
  return {
    kind: 'email',
    validate: (c) =>
      Array.isArray(c.to) &&
      c.to.length > 0 &&
      c.to.every((x) => typeof x === 'string' && x.includes('@'))
        ? null
        : 'to must be a non-empty list of email addresses',
    async send(channel, p) {
      if (!transport || !smtp)
        throw new Error(
          'SMTP is not configured: set THEIRSIDE_SMTP_URL (or THEIRSIDE_SMTP_HOST) on the collector',
        );
      const m = renderEmail(p);
      try {
        await transport.sendMail({
          from: smtp.from,
          to: (channel.config.to as string[]).join(', '),
          subject: m.subject,
          text: m.text,
          html: m.html,
        });
      } catch (err) {
        throw new Error(describeSendError(err), { cause: err });
      }
    },
  };
}

export function defaultAdapters(
  smtp: SmtpConfig | undefined,
): Map<AlertChannelRecord['kind'], ChannelAdapter> {
  return new Map<AlertChannelRecord['kind'], ChannelAdapter>([
    ['slack', slackAdapter],
    ['webhook', webhookAdapter],
    ['email', emailAdapter(smtp)],
  ]);
}
