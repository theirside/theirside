import { PRODUCT_NAME, PRODUCT_URL } from '@theirside/shared';
import type { PublicStatus, PublicStatusData } from './data.js';

export type Theme = 'auto' | 'light' | 'dark';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const LABEL: Record<PublicStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Outage',
  no_data: 'No recent data',
};

const OVERALL: Record<PublicStatus, string> = {
  operational: 'All integrations operational',
  degraded: 'Some integrations are degraded',
  outage: 'Some integrations are down',
  no_data: 'No recent data',
};

function pct(x: number): string {
  const p = x * 100;
  return p >= 99.995 ? '100%' : `${p.toFixed(2)}%`;
}

const LIGHT = `--bg:#f5f6f8;--fg:#0f1115;--muted:#5a5e68;--line:#dfe1e6;--card:#ffffff;--ok:#1a7a4c;--deg:#8a5600;--out:#c0262d;--none:#c9ccd3;`;
const DARK = `--bg:#09090b;--fg:#f1f2f4;--muted:#9a9da6;--line:#26272d;--card:#151519;--ok:#3dd68c;--deg:#f2b35a;--out:#ff6b6b;--none:#3a3b42;`;

function css(theme: Theme): string {
  const vars =
    theme === 'light'
      ? `:root{${LIGHT}}`
      : theme === 'dark'
        ? `:root{${DARK}}`
        : `:root{${LIGHT}}@media (prefers-color-scheme: dark){:root{${DARK}}}`;
  return `${vars}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/21px "Helvetica Neue",Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:24px 16px}
.embed .wrap{padding:8px 0;max-width:none}
h1{font-size:22px;line-height:28px;font-weight:600;margin:0 0 24px}
.overall{display:flex;align-items:center;gap:10px;padding:14px 16px;border:1px solid var(--line);border-radius:16px;background:var(--card);margin-bottom:32px;font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;flex:none}
.operational .dot,.dot.operational{background:var(--ok)}.degraded .dot,.dot.degraded{background:var(--deg)}.outage .dot,.dot.outage{background:var(--out)}.no_data .dot,.dot.no_data{background:var(--none)}
.provider{padding:24px 0;border-top:1px solid var(--line)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.name{font-weight:600}
.state{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:13px;white-space:nowrap}
.bars{display:flex;gap:2px;margin-top:10px;height:28px}
.bar{flex:1;border-radius:2px;background:var(--none);min-width:2px}
.bar.ok{background:var(--ok)}.bar.degraded{background:var(--deg)}.bar.outage{background:var(--out)}
.legend{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:6px}
.foot{color:var(--muted);font-size:12px;margin-top:18px}.foot a{color:inherit}
.empty{color:var(--muted);padding:12px 0}`;
}

export function renderStatusPage(
  data: PublicStatusData,
  /** poweredBy: the footer link, shown unless the org has whiteLabelStatusPage. */
  opts: { theme: Theme; embed: boolean; poweredBy: boolean },
): string {
  const rows = data.providers
    .map((p) => {
      const bars = p.days
        .map((d) => {
          const tip =
            d.uptime === null
              ? `${d.date}: no data`
              : `${d.date}: ${pct(d.uptime)} uptime${d.level !== 'ok' ? ` (${d.level})` : ''}`;
          return `<div class="bar ${d.level}" title="${esc(tip)}"></div>`;
        })
        .join('');
      return `<div class="provider">
  <div class="row"><span class="name">${esc(p.name)}</span><span class="state"><span class="dot ${p.status}"></span>${LABEL[p.status]}</span></div>
  <div class="bars" aria-label="30-day history">${bars}</div>
  <div class="legend"><span>30 days ago</span><span>${p.uptime30d === null ? '' : `${pct(p.uptime30d)} uptime`}</span><span>Today</span></div>
</div>`;
    })
    .join('\n');

  const resize = opts.embed
    ? `<script>(function(){function send(){parent.postMessage({type:'theirside-status-height',height:document.documentElement.scrollHeight},'*')}addEventListener('load',send);addEventListener('resize',send);})();</script>`
    : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.title)}</title>
<meta name="robots" content="noindex">
<style>${css(opts.theme)}</style>
</head><body class="${opts.embed ? 'embed' : ''}">
<div class="wrap">
${opts.embed ? '' : `<h1>${esc(data.title)}</h1>`}
<div class="overall ${data.overall}"><span class="dot"></span>${OVERALL[data.overall]}</div>
${rows || '<div class="empty">No integrations are published on this page yet.</div>'}
<div class="foot">Updated ${esc(data.generatedAt.slice(0, 16).replace('T', ' '))} UTC${
    opts.poweredBy
      ? ` · <a href="${esc(PRODUCT_URL)}" target="_blank" rel="noopener">Powered by ${esc(PRODUCT_NAME)}</a>`
      : ''
  }</div>
</div>
${resize}
</body></html>`;
}

/**
 * embed.js: `<script src="https://collector.example/embed.js" data-token="…"
 * data-theme="auto|light|dark" data-providers="Card issuing,KYC" async></script>`
 * inserts an auto-height iframe of /status/<token>.
 */
export function embedScript(origin: string): string {
  return `(function(){
  var s = document.currentScript; if (!s) return;
  var token = s.getAttribute('data-token'); if (!token) { console.warn('[theirside] embed.js: data-token missing'); return; }
  var q = ['embed=1'];
  var theme = s.getAttribute('data-theme'); if (theme) q.push('theme=' + encodeURIComponent(theme));
  var providers = s.getAttribute('data-providers'); if (providers) q.push('providers=' + encodeURIComponent(providers));
  var f = document.createElement('iframe');
  f.src = ${JSON.stringify(origin)} + '/status/' + encodeURIComponent(token) + '?' + q.join('&');
  f.title = s.getAttribute('data-title') || 'Integration status';
  f.loading = 'lazy';
  f.style.cssText = 'width:100%;border:0;height:' + (s.getAttribute('data-height') || '320') + 'px;color-scheme:normal';
  window.addEventListener('message', function (e) {
    if (e.source === f.contentWindow && e.data && e.data.type === 'theirside-status-height') f.style.height = e.data.height + 'px';
  });
  s.parentNode.insertBefore(f, s.nextSibling);
})();
`;
}
