import { PRODUCT_NAME } from '@theirside/shared';
import { ms, pct } from '../incidents/summary.js';
import type { AlertPayload } from './channels.js';

/**
 * Message rendering for Slack and email, kept pure so the exact output is
 * snapshot-tested (test/alert-render.test.ts). Webhooks get the raw payload.
 */

const LABEL: Record<AlertPayload['event'], string> = {
  open: 'Incident opened',
  escalation: 'Incident escalated',
  resolve: 'Incident resolved',
  test: 'Test alert',
  discovery: 'New providers discovered',
};

const EMOJI: Record<AlertPayload['event'], string> = {
  open: ':red_circle:',
  escalation: ':rotating_light:',
  resolve: ':large_green_circle:',
  test: ':white_check_mark:',
  discovery: ':mag:',
};

/** Slack limits (api.slack.com/reference/block-kit): we stay well inside them. */
export const SLACK_LIMITS = {
  headerText: 150,
  sectionText: 3000,
  fieldText: 2000,
  fields: 10,
  blocks: 50,
  /** Slack truncates the top-level `text` fallback beyond this. */
  fallbackText: 4000,
  buttonUrl: 3000,
} as const;

/** Endpoints listed individually; the rest are summarised in one line. */
const MAX_ENDPOINTS_LISTED = 5;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Slack mrkdwn needs &, < and > escaped in user-provided text. */
const mrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline code for Slack: a backtick inside would end the span early. */
const code = (s: string) => '`' + mrkdwn(s.replace(/`/g, "'")) + '`';

const HOST = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z][a-z0-9-]*[a-z0-9](?::\d+)?`;
/**
 * Endpoint templates (`/v2/cards/:id`) and hosts (`api.acme.com:443`, with a
 * path) in free text. Not inside URLs or emails (preceded by `/`, `:`, `@`,
 * `.` or a word character), and without trailing sentence punctuation.
 */
const CODE_TOKEN = new RegExp(
  String.raw`(?<![\w@./:\`-])(?:${HOST}(?:/[^\s,;()<>\`]*)?|/[^\s,;()<>\`]+)`,
  'gi',
);

/**
 * Text for Slack mrkdwn (and the notification fallback, which Slack formats
 * too): endpoint templates and hosts in inline code, so `:id:` never turns
 * into an emoji and `_` or `*` in a path don't format; &, < and > escaped; and
 * emoji shortcodes in the remaining text (`:fire:` in a provider name) broken
 * with a zero-width space so they stay text.
 */
export function slackText(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(CODE_TOKEN)) {
    let token = m[0];
    const trail = /[.:!?]+$/.exec(token)?.[0] ?? '';
    token = token.slice(0, token.length - trail.length);
    if (token.length < 2) continue;
    out += plain(s.slice(last, m.index)) + code(token);
    last = m.index + token.length;
  }
  return out + plain(s.slice(last));
}

/** Plain text in mrkdwn: escaped, emoji shortcodes kept as text. */
const plain = (s: string) => mrkdwn(s).replace(/:([a-z0-9_+-]+):/gi, ':\u200b$1:');

function duration(p: AlertPayload): string | null {
  if (p.durationMinutes === undefined || p.durationMinutes === null || !p.openedAt) return null;
  const since = `${p.openedAt.slice(11, 16)} UTC`;
  return p.event === 'resolve'
    ? `${p.durationMinutes} min (from ${since})`
    : `${p.durationMinutes} min (since ${since})`;
}

/** Who the alert is about: `Stripe`, or `Stripe webhooks` for inbound ones. */
const subject = (p: AlertPayload) =>
  p.direction === 'inbound' ? `${p.provider} webhooks` : p.provider;

/**
 * "POST /v1/x: errors 38% (normal 0.2%), p95 2.5 s (normal 180 ms)"; inbound:
 * "POST /webhooks/stripe: rejected 38% (normal 0.2%), handler p95 …"
 */
function endpointLine(e: AlertPayload['endpoints'][number], inbound = false): string {
  const parts: string[] = [];
  if (e.errorRate !== null)
    parts.push(
      `${inbound ? 'rejected' : 'errors'} ${pct(e.errorRate)}${e.normalErrorRate !== null ? ` (normal ${pct(e.normalErrorRate)})` : ''}`,
    );
  if (e.p95Ms !== null && e.p95Ms !== undefined)
    parts.push(
      `${inbound ? 'handler p95' : 'p95'} ${ms(e.p95Ms)}${e.normalP95Ms !== null && e.normalP95Ms !== undefined ? ` (normal ${ms(e.normalP95Ms)})` : ''}`,
    );
  return `${e.method} ${e.endpoint}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

function endpointLines(p: AlertPayload): string[] {
  const shown = p.endpoints
    .slice(0, MAX_ENDPOINTS_LISTED)
    .map((e) => endpointLine(e, p.direction === 'inbound'));
  const more = p.endpoints.length - shown.length;
  if (more > 0) shown.push(`…and ${more} more endpoint${more === 1 ? '' : 's'}`);
  return shown;
}

function supportText(p: AlertPayload): string | null {
  if (!p.support) return null;
  return [p.support.email, p.support.url].filter(Boolean).join(' · ') || null;
}

/**
 * Plain-text fallback: notifications, screen readers, clients without Block
 * Kit. Slack formats it as mrkdwn too, so it gets the same treatment.
 */
export function slackFallbackText(p: AlertPayload): string {
  // the digest's title already says what it is ("3 new providers discovered: …")
  const head = p.event === 'discovery' ? '' : `${LABEL[p.event]}: `;
  const lines = [`${head}${slackText(p.title)}`, slackText(p.otherEndpointsText)];
  if (p.url) lines.push(p.url);
  return cut(lines.filter(Boolean).join('\n'), SLACK_LIMITS.fallbackText);
}

/** The hourly "new providers discovered" digest: a list, no incident fields. */
/** The webhook-route message: one line per route ("POST /v1/x (suggested: x) · billing-api"). */
function routeItems(p: AlertPayload, fmt: (s: string) => string): string[] {
  return (p.webhookRoutes ?? []).map(
    (r) =>
      `${fmt(`${r.method} ${r.endpoint}`)}${r.suggestedName ? ` (suggested: ${r.suggestedName})` : ''}${r.service ? ` · received by ${r.service}` : ''}`,
  );
}

function renderSlackDiscovery(p: AlertPayload): { text: string; blocks: unknown[] } {
  if (p.webhookRoutes) return renderSlackRoutes(p);
  const items = (p.discovered ?? [])
    .slice(0, 40)
    .map(
      (d) =>
        `• *${slackText(d.label)}*${d.category ? ` (${slackText(d.category)})` : ''}: ${d.hosts.slice(0, 3).map(code).join(', ')}${d.alertsEnabled ? '' : ' · alerts off'}`,
    );
  const more = (p.discovered?.length ?? 0) - items.length;
  if (more > 0) items.push(`…and ${more} more`);
  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: cut(LABEL.discovery, SLACK_LIMITS.headerText),
        emoji: false,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: cut(items.join('\n') || slackText(p.title), SLACK_LIMITS.sectionText),
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: cut(slackText(p.otherEndpointsText), SLACK_LIMITS.sectionText) },
      ],
    },
  ];
  if (p.url)
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Review providers' }, url: p.url },
      ],
    });
  return { text: slackFallbackText(p), blocks };
}

function renderSlackRoutes(p: AlertPayload): { text: string; blocks: unknown[] } {
  const items = routeItems(p, (s) => code(s)).slice(0, 40);
  const more = (p.webhookRoutes?.length ?? 0) - items.length;
  if (more > 0) items.push(`…and ${more} more`);
  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: cut(
          p.webhookRoutes!.length === 1
            ? 'New webhook route discovered'
            : 'New webhook routes discovered',
          SLACK_LIMITS.headerText,
        ),
        emoji: false,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: cut(items.join('\n'), SLACK_LIMITS.sectionText) },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: cut(slackText(p.otherEndpointsText), SLACK_LIMITS.sectionText) },
      ],
    },
  ];
  if (p.url)
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Review webhook routes' }, url: p.url },
      ],
    });
  return { text: slackFallbackText(p), blocks };
}

export function renderSlack(p: AlertPayload): { text: string; blocks: unknown[] } {
  if (p.event === 'discovery') return renderSlackDiscovery(p);
  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        // plain text, so no code spans: with emoji off, `:id:` stays text here
        text: cut(`${LABEL[p.event]}: ${subject(p)}`, SLACK_LIMITS.headerText),
        emoji: false,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: cut(`${EMOJI[p.event]} *${slackText(p.title)}*`, SLACK_LIMITS.sectionText),
      },
    },
  ];

  const fields: string[] = [];
  const dur = duration(p);
  if (dur) fields.push(`*Duration*\n${dur}`);
  fields.push(`*Environment*\n${slackText(p.environment)}`);
  const support = supportText(p);
  if (support) fields.push(`*Provider support*\n${slackText(support)}`);
  blocks.push({
    type: 'section',
    fields: fields
      .slice(0, SLACK_LIMITS.fields)
      .map((t) => ({ type: 'mrkdwn', text: cut(t, SLACK_LIMITS.fieldText) })),
  });

  if (p.endpoints.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: cut(
          endpointLines(p)
            .map((l) => `• ${slackText(l)}`)
            .join('\n'),
          SLACK_LIMITS.sectionText,
        ),
      },
    });
  }
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: cut(
        `${p.otherEndpointsOk ? ':white_check_mark:' : ':warning:'} ${slackText(p.otherEndpointsText)}`,
        SLACK_LIMITS.sectionText,
      ),
    },
  });
  if (p.summary) {
    // ``` + text + ``` must fit the section limit
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```' + cut(mrkdwn(p.summary), SLACK_LIMITS.sectionText - 6) + '```',
      },
    });
  }
  if (p.url && p.url.length <= SLACK_LIMITS.buttonUrl) {
    const mark = p.markExpectedUrl && p.markExpectedUrl.length <= SLACK_LIMITS.buttonUrl;
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in dashboard' },
          url: p.url,
          ...(p.event === 'resolve' || p.event === 'test' ? {} : { style: 'danger' }),
        },
        ...(mark
          ? [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Mark as expected' },
                url: p.markExpectedUrl,
              },
            ]
          : []),
      ],
    });
    if (mark)
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Is this status a normal answer for this endpoint? Mark it as expected. Marking it in your code (`markExpected`) is more precise: only the calls you tag count as fine.',
          },
        ],
      });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${PRODUCT_NAME} · ${slackText(p.environment)}` }],
  });
  return { text: slackFallbackText(p), blocks: blocks.slice(0, SLACK_LIMITS.blocks) };
}

/** "[Theirside] Acme Cards POST /v2/cards/:id/activate failing 38%" */
export function emailSubject(p: AlertPayload): string {
  const title = p.title.replace(/^([^:]+): /, '$1 ').replace(/\((\d+(?:\.\d+)?%)\)/, '$1');
  const prefix = p.event === 'open' ? '' : `${LABEL[p.event]}: `;
  return cut(`[${PRODUCT_NAME}] ${prefix}${title}`, 200);
}

const html = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function renderEmailDiscovery(p: AlertPayload): { subject: string; text: string; html: string } {
  const routes = !!p.webhookRoutes;
  const heading = routes
    ? p.webhookRoutes!.length === 1
      ? 'New webhook route discovered'
      : 'New webhook routes discovered'
    : LABEL.discovery;
  const button = routes ? 'Review webhook routes' : 'Review providers';
  const items = routes
    ? routeItems(p, (s) => s)
    : (p.discovered ?? []).map(
        (d) =>
          `${d.label}${d.category ? ` (${d.category})` : ''}: ${d.hosts.slice(0, 3).join(', ')}${d.alertsEnabled ? '' : ' (alerts off)'}`,
      );
  const text = [
    p.title,
    '',
    ...items.map((i) => `- ${i}`),
    '',
    p.otherEndpointsText,
    ...(p.url ? ['', `${button}: ${p.url}`] : []),
    '',
    `-- ${PRODUCT_NAME}`,
  ].join('\n');
  const body = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:8px;padding:20px">
<h1 style="font-size:18px;margin:0 0 14px">${html(heading)}</h1>
<ul style="font-size:14px;padding-left:18px;margin:0 0 12px">${items.map((i) => `<li>${html(i)}</li>`).join('')}</ul>
<p style="font-size:13px;color:#59636e;margin:0 0 14px">${html(p.otherEndpointsText)}</p>
${p.url ? `<a href="${html(p.url)}" style="display:inline-block;background:#1f2328;color:#ffffff;text-decoration:none;font-size:14px;padding:8px 14px;border-radius:6px">${html(button)}</a>\n` : ''}</div>
</body></html>`;
  return { subject: cut(`[${PRODUCT_NAME}] ${p.title}`, 200), text, html: body };
}

export function renderEmail(p: AlertPayload): { subject: string; text: string; html: string } {
  if (p.event === 'discovery') return renderEmailDiscovery(p);
  const dur = duration(p);
  const support = supportText(p);
  const facts: [string, string][] = [
    ...(dur ? [['Duration', dur] as [string, string]] : []),
    ['Environment', p.environment],
    ...(support ? [['Provider support', support] as [string, string]] : []),
  ];

  const text = [
    `${LABEL[p.event]}: ${p.title}`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    ...endpointLines(p).map((l) => `- ${l}`),
    p.otherEndpointsText,
    '',
    'Summary for the provider (paste as is):',
    p.summary,
    ...(p.url ? ['', `Open in dashboard: ${p.url}`] : []),
    ...(p.markExpectedUrl
      ? [
          `Is this status a normal answer for this endpoint? Mark it as expected: ${p.markExpectedUrl}`,
          '(Marking it in your code with markExpected is more precise.)',
        ]
      : []),
    '',
    `-- ${PRODUCT_NAME}`,
  ].join('\n');

  const color = p.event === 'resolve' || p.event === 'test' ? '#1a7f37' : '#cf222e';
  const body = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:8px;padding:20px">
<div style="font-size:13px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:.04em">${html(LABEL[p.event])}</div>
<h1 style="font-size:18px;margin:6px 0 14px">${html(p.title)}</h1>
<table style="border-collapse:collapse;font-size:14px;margin-bottom:12px">${facts
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 16px 2px 0;color:#59636e">${html(k)}</td><td style="padding:2px 0">${html(v)}</td></tr>`,
    )
    .join('')}</table>
${
  p.endpoints.length
    ? `<ul style="font-size:14px;padding-left:18px;margin:0 0 10px">${endpointLines(p)
        .map((l) => `<li>${html(l)}</li>`)
        .join('')}</ul>`
    : ''
}<p style="font-size:14px;margin:0 0 14px">${html(p.otherEndpointsText)}</p>
<div style="font-size:12px;color:#59636e;margin-bottom:4px">Summary for the provider (paste as is):</div>
<pre style="white-space:pre-wrap;font-size:13px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:10px;margin:0 0 16px">${html(p.summary)}</pre>
${
  p.url
    ? `<a href="${html(p.url)}" style="display:inline-block;background:#1f2328;color:#ffffff;text-decoration:none;font-size:14px;padding:8px 14px;border-radius:6px">Open in dashboard</a>\n`
    : ''
}</div>
<div style="max-width:640px;margin:10px auto 0;font-size:12px;color:#59636e;text-align:center">${html(PRODUCT_NAME)}</div>
</body></html>`;

  return { subject: emailSubject(p), text, html: body };
}
