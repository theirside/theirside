// Writes SUMMARY.md for an overnight soak (overnight.mjs) from the per-variant
// CSVs in one results folder. Also runs on its own, e.g. after a hard stop:
//   node src/summary.mjs results/2026-11-04 [--warmup 10]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VARIANTS = [
  { id: 'a', file: 'a-sdk-collector-up.csv', label: '(a) SDK on, collector up' },
  { id: 'b', file: 'b-sdk-collector-unreachable.csv', label: '(b) SDK on, collector unreachable' },
  { id: 'c', file: 'c-sdk-off.csv', label: '(c) SDK off (control)' },
];

/** Verdict thresholds; written into SUMMARY.md so the numbers explain themselves. */
export const LIMITS = {
  /** Heap of an SDK variant, second-half slope: above this with a clear trend = growing. */
  heapMbPerHour: 0.25,
  /** RSS gap to the control, second-half slope: below this the gap has levelled off. */
  rssGapMbPerHour: 1,
  /** Heap gap to the control, second-half slope. */
  heapGapMbPerHour: 0.1,
  /** A trend needs at least this R² to count. */
  r2: 0.5,
};

const MB = 1048576;

function parseCsv(file) {
  const [head, ...lines] = readFileSync(file, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, ''));
    const row = {};
    cols.forEach((c, i) => {
      const v = (cells[i] ?? '').replace(/^"|"$/g, '').replace(/""/g, '"');
      row[c] = v === '' ? null : /^-?[\d.]+$/.test(v) ? Number(v) : v;
    });
    return row;
  });
}

/** Least squares over [hours, MB] points: slope MB/h and R². */
function trend(points) {
  const n = points.length;
  if (n < 3) return { slope: NaN, r2: NaN, n };
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return { slope: sxx ? sxy / sxx : 0, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0, n };
}

const median = (xs) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const signed = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : 'n/a');
/** Hours as `8h00`: rounds to whole minutes first, so 7.9999 h is 8h00, not 7h60. */
const hm = (h) => {
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};

export function summarize(dir, { warmupMin = 10, plannedHours } = {}) {
  const data = {};
  for (const v of VARIANTS) {
    const file = path.join(dir, v.file);
    data[v.id] = existsSync(file) ? parseCsv(file) : [];
  }
  const missing = VARIANTS.filter((v) => data[v.id].length === 0).map((v) => v.label);
  // aligned by sample index: all three start together and sample on the same period
  const n = Math.min(...VARIANTS.map((v) => data[v.id].length));
  const hours = (r) => r.t / 3600;
  const ranHours = n > 0 ? hours(data.a[n - 1] ?? data.c[n - 1]) : 0;
  const mid = ranHours / 2;
  const w = warmupMin / 60;
  const inWindow = (h, part) =>
    h >= w && (part === 'all' || (part === 'first' ? h < mid : h >= mid));

  const series = (id, field) => data[id].slice(0, n).map((r) => [hours(r), r[field] / MB]);
  const gapSeries = (x, field) =>
    data[x].slice(0, n).map((r, i) => [hours(r), (r[field] - data.c[i][field]) / MB]);
  const fit = (pts, part) => trend(pts.filter(([h]) => inWindow(h, part)));
  const level = (pts, which) => {
    const kept = pts.filter(([h]) => h >= w);
    const span = Math.max(1, Math.round(kept.length * 0.0625)); // ~30 min of an 8 h run
    const slice = which === 'start' ? kept.slice(0, span) : kept.slice(-span);
    return median(slice.map((p) => p[1]));
  };

  const lines = [];
  const out = (s = '') => lines.push(s);
  out(`# Overnight SDK soak: ${path.basename(dir)}`);
  out();
  out(
    `Ran ${hm(ranHours)}${plannedHours ? ` of ${plannedHours} h planned` : ''}, ${n} aligned samples per variant, warm-up ${warmupMin} min excluded. "First half" / "second half" split the run at ${hm(mid)}${plannedHours === 8 && ranHours > 7.9 ? ' (first 4 h vs last 4 h)' : ''}. Heap is measured after a forced GC; RSS is the whole process.`,
  );
  if (missing.length)
    out(`\n**Missing data:** ${missing.join(', ')}. The comparison below is incomplete.`);
  out();

  // per variant
  out('## Per variant (slopes in MB per hour)');
  out();
  out(
    '| Variant | Heap start → end MB | Heap slope (R²) | Heap 1st half | Heap 2nd half | RSS start → end MB | RSS slope (R²) | RSS 1st half | RSS 2nd half |',
  );
  out('|---|---|---|---|---|---|---|---|---|');
  const per = {};
  for (const v of VARIANTS) {
    const heap = series(v.id, 'heapUsed');
    const rss = series(v.id, 'rss');
    per[v.id] = {
      heapAll: fit(heap, 'all'),
      heapFirst: fit(heap, 'first'),
      heapSecond: fit(heap, 'second'),
      rssAll: fit(rss, 'all'),
      rssFirst: fit(rss, 'first'),
      rssSecond: fit(rss, 'second'),
    };
    const p = per[v.id];
    out(
      `| ${v.label} | ${f(level(heap, 'start'))} → ${f(level(heap, 'end'))} | ${signed(p.heapAll.slope, 3)} (${f(p.heapAll.r2)}) | ${signed(p.heapFirst.slope, 3)} | ${signed(p.heapSecond.slope, 3)} | ${f(level(rss, 'start'), 0)} → ${f(level(rss, 'end'), 0)} | ${signed(p.rssAll.slope)} (${f(p.rssAll.r2)}) | ${signed(p.rssFirst.slope)} | ${signed(p.rssSecond.slope)} |`,
    );
  }
  out();

  // gaps to the control
  out('## SDK cost: gap to the control (a − c, b − c)');
  out();
  out(
    '| Gap | Heap gap start → end MB | Heap gap slope 1st half → 2nd half | RSS gap start → end MB | RSS gap slope 1st half → 2nd half | Levels off? |',
  );
  out('|---|---|---|---|---|---|');
  const gaps = {};
  for (const x of ['a', 'b']) {
    const hg = gapSeries(x, 'heapUsed');
    const rg = gapSeries(x, 'rss');
    const g = {
      heapFirst: fit(hg, 'first'),
      heapSecond: fit(hg, 'second'),
      rssFirst: fit(rg, 'first'),
      rssSecond: fit(rg, 'second'),
    };
    g.rssLevels = !(g.rssSecond.slope >= LIMITS.rssGapMbPerHour);
    g.heapLevels = !(g.heapSecond.slope >= LIMITS.heapGapMbPerHour);
    gaps[x] = g;
    out(
      `| ${x} − c | ${signed(level(hg, 'start'))} → ${signed(level(hg, 'end'))} | ${signed(g.heapFirst.slope, 3)} → ${signed(g.heapSecond.slope, 3)} | ${signed(level(rg, 'start'), 0)} → ${signed(level(rg, 'end'), 0)} | ${signed(g.rssFirst.slope)} → ${signed(g.rssSecond.slope)} | RSS ${g.rssLevels ? 'yes' : 'no'}, heap ${g.heapLevels ? 'yes' : 'no'} |`,
    );
  }
  out();
  out(
    `"Levels off" = the gap's second-half slope is below ${LIMITS.rssGapMbPerHour} MB/h for RSS (24 MB a day) and ${LIMITS.heapGapMbPerHour} MB/h for heap.`,
  );
  out();

  // traffic sanity
  out('## Traffic and SDK counters (last sample)');
  out();
  out(
    '| Variant | Calls made | App errors | SDK sent | SDK queued | SDK dropped | Last flush error |',
  );
  out('|---|---|---|---|---|---|---|');
  for (const v of VARIANTS) {
    const last = data[v.id][n - 1] ?? {};
    out(
      `| ${v.label} | ${last.calls ?? 'n/a'} | ${last.appErrors ?? 'n/a'} | ${last.sent ?? '–'} | ${last.queued ?? '–'} | ${last.dropped ?? '–'} | ${last.lastFlushError ?? '–'} |`,
    );
  }
  out();

  // verdict
  const reasons = [];
  if (missing.length) reasons.push(`missing data for ${missing.join(', ')}`);
  if (ranHours < 2) reasons.push(`only ${hm(ranHours)} of data: too short to judge a trend`);
  for (const x of ['a', 'b']) {
    const h = per[x].heapSecond;
    if (h.slope >= LIMITS.heapMbPerHour && h.r2 >= LIMITS.r2)
      reasons.push(
        `${x}: heap still growing in the second half (${signed(h.slope, 3)} MB/h, R² ${f(h.r2)})`,
      );
    if (!gaps[x].rssLevels)
      reasons.push(
        `${x} − c: RSS gap still growing in the second half (${signed(gaps[x].rssSecond.slope)} MB/h ≈ ${f(gaps[x].rssSecond.slope * 24, 0)} MB/day)`,
      );
    if (!gaps[x].heapLevels)
      reasons.push(
        `${x} − c: heap gap still growing (${signed(gaps[x].heapSecond.slope, 3)} MB/h)`,
      );
  }
  const lastA = data.a[n - 1];
  if (lastA && lastA.lastFlushError)
    reasons.push(
      `a: the SDK reported a flush error at the end (${lastA.lastFlushError}); check the collector`,
    );
  out('## Verdict');
  out();
  if (reasons.length === 0) {
    out(
      `**OK for production.** SDK heap is flat in the second half (below ${LIMITS.heapMbPerHour} MB/h or no clear trend) and the RSS gap to the control levelled off with the collector up and with it unreachable.`,
    );
  } else {
    out('**Needs investigation:**');
    out();
    for (const r of reasons) out(`- ${r}`);
  }
  out();
  out(
    `Thresholds: SDK heap second-half slope < ${LIMITS.heapMbPerHour} MB/h unless R² < ${LIMITS.r2}; RSS gap second-half slope < ${LIMITS.rssGapMbPerHour} MB/h; heap gap second-half slope < ${LIMITS.heapGapMbPerHour} MB/h. Raw samples: the CSVs next to this file (one row per 30 s).`,
  );
  const summaryPath = path.join(dir, 'SUMMARY.md');
  writeFileSync(summaryPath, lines.join('\n') + '\n');
  return { summaryPath, ok: reasons.length === 0, reasons };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node src/summary.mjs <results dir> [--warmup 10]');
    process.exit(2);
  }
  const i = process.argv.indexOf('--warmup');
  const r = summarize(dir, { warmupMin: i > 0 ? Number(process.argv[i + 1]) : 10 });
  console.log(`${r.ok ? 'OK' : 'needs investigation'}: ${r.summaryPath}`);
}
