import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useThemeVersion } from '../theme';
import { LegendCheckbox } from './ui';

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  /** A token: `var(--chart-N)` or a semantic colour such as `var(--color-danger)`. */
  color: string;
  /** Dashed reference line (baseline band edges). */
  dash?: boolean;
  /** Fill under the line, as a fraction of the line colour's opacity (e.g. 0.12). */
  fillAlpha?: number;
}

/** `var(--x)` → the colour it resolves to now (canvas can't use CSS variables). */
function resolve(css: CSSStyleDeclaration, color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
  return m ? css.getPropertyValue(m[1]!).trim() : color;
}

/** `#RRGGBB` + alpha → `#RRGGBBAA`. */
function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  return (
    hex +
    Math.round(alpha * 255)
      .toString(16)
      .padStart(2, '0')
  );
}

/**
 * Small uPlot wrapper: time on x (ISO strings), one y scale, optional baseline
 * lines. The legend is a row of coloured checkboxes; which series are hidden is
 * kept across data refreshes and theme changes.
 */
export function Chart({
  times,
  series,
  height = 180,
  format = (v: number) => String(v),
  yMin,
}: {
  times: string[];
  series: ChartSeries[];
  height?: number;
  format?: (v: number) => string;
  yMin?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [cursor, setCursor] = useState<number | null>(null);
  const theme = useThemeVersion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const xs = times.map((t) => new Date(t).getTime() / 1000);
    // the element's own values: a data-theme panel (the gallery) can differ from <html>
    const css = getComputedStyle(el);
    const muted = resolve(css, 'var(--color-text-muted)');
    const grid = resolve(css, 'var(--color-grid)');
    const font = `${resolve(css, 'var(--text-xs)')} ${resolve(css, 'var(--font-ui)')}`;
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      // times in UTC, like the rest of the dashboard and the alerts
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC'),
      scales: {
        x: { time: true },
        y: { range: (_u, min, max) => [yMin ?? Math.min(0, min), max > 0 ? max * 1.1 : 1] },
      },
      axes: [
        {
          stroke: muted,
          font,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
        },
        {
          stroke: muted,
          font,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
          values: (_u, vals) => vals.map((v) => format(v)),
          size: 60,
        },
      ],
      hooks: { setCursor: [(u) => setCursor(u.cursor.idx ?? null)] },
      series: [
        {},
        ...series.map((s) => {
          const stroke = resolve(css, s.color);
          return {
            label: s.label,
            stroke,
            show: !hiddenRef.current.has(s.label),
            width: s.dash ? 1 : 1.5,
            ...(s.dash ? { dash: [4, 4] } : {}),
            ...(s.fillAlpha ? { fill: withAlpha(stroke, s.fillAlpha) } : {}),
            points: { show: false },
          };
        }),
      ],
    };
    const plot = new uPlot(opts, [xs, ...series.map((s) => s.values)] as uPlot.AlignedData, el);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [times, series, height, format, yMin, theme]);

  const toggle = (i: number, show: boolean) => {
    const label = series[i]!.label;
    const next = new Set(hidden);
    if (show) next.delete(label);
    else next.add(label);
    setHidden(next);
    plotRef.current?.setSeries(i + 1, { show });
  };

  return (
    <div className="chart">
      <div ref={ref} className="chart-plot" />
      <div className="legend" role="group" aria-label="Series">
        {series.map((s, i) => {
          const v = cursor === null ? undefined : s.values[cursor];
          return (
            <LegendCheckbox
              key={s.label}
              label={s.label}
              color={s.color}
              checked={!hidden.has(s.label)}
              onChange={(show) => toggle(i, show)}
              dashed={!!s.dash}
              value={cursor === null ? undefined : v === null || v === undefined ? '–' : format(v)}
            />
          );
        })}
      </div>
    </div>
  );
}
