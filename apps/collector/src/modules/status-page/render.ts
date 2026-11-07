import { PRODUCT_NAME, PRODUCT_URL } from '@theirside/shared';
import { fontFaceCss, themeCss } from '@theirside/design';
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

/** Served by the collector at /fonts/ (status-page/routes.ts); relative, so a path prefix works. */
const FONTS = fontFaceCss('../fonts/');

function css(theme: Theme): string {
  return `${FONTS}
${themeCss(theme)}
*{box-sizing:border-box}
body{margin:0;background:var(--color-background);color:var(--color-text);font:var(--text-base)/var(--leading-base) var(--font-ui)}
.wrap{max-width:var(--size-page-narrow);margin:0 auto;padding:var(--space-6) var(--space-4)}
.embed .wrap{padding:var(--space-2) 0;max-width:none}
h1{font-size:var(--text-xl);line-height:var(--leading-xl);font-weight:var(--weight-bold);margin:0 0 var(--space-6)}
.overall{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-xl);background:var(--color-surface);margin-bottom:var(--space-8);font-weight:var(--weight-semibold)}
.dot{width:var(--size-dot);height:var(--size-dot);border-radius:var(--radius-full);flex:none;background:var(--color-neutral)}
.operational .dot,.dot.operational{background:var(--color-healthy)}.degraded .dot,.dot.degraded{background:var(--color-warning)}.outage .dot,.dot.outage{background:var(--color-danger)}.no_data .dot,.dot.no_data{background:var(--color-neutral)}
.provider{padding:var(--space-6) 0;border-top:1px solid var(--color-border)}
.row{display:flex;justify-content:space-between;align-items:center;gap:var(--space-3)}
.name{font-weight:var(--weight-semibold)}
.state{display:flex;align-items:center;gap:var(--space-2);color:var(--color-text-muted);font-size:var(--text-md);line-height:var(--leading-md);white-space:nowrap}
.bars{display:flex;gap:var(--space-0_5);margin-top:var(--space-3);height:var(--size-status-bar)}
.bar{flex:1;border-radius:var(--space-0_5);background:var(--color-neutral);min-width:var(--space-0_5)}
.bar.ok{background:var(--color-healthy)}.bar.degraded{background:var(--color-warning)}.bar.outage{background:var(--color-danger)}
.legend{display:flex;justify-content:space-between;color:var(--color-text-muted);font-size:var(--text-sm);line-height:var(--leading-sm);margin-top:var(--space-2)}
.foot{color:var(--color-text-muted);font-size:var(--text-sm);line-height:var(--leading-sm);margin-top:var(--space-5)}.foot a{color:inherit}
.empty{color:var(--color-text-muted);padding:var(--space-3) 0}`;
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
