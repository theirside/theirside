import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  /** Design token name, without the leading dashes. */
  color: string;
  /** Dashed reference line (baseline band edges). */
  dash?: boolean;
  /** Design token name, without the leading dashes. */
  fill?: string;
}

/** Small uPlot wrapper: time on x (ISO strings), one y scale, optional baseline lines. */
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
  // data polls rebuild the plot: keep what the user switched off
  const hidden = useRef(new Set<string>());
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const xs = times.map((t) => new Date(t).getTime() / 1000);
    // canvas can't resolve CSS variables: read the theme colours when drawing
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(`--${name}`).trim();
    const muted = token('ink-muted');
    const grid = token('line');
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      legend: {
        show: true,
        // coloured checkboxes: filled when shown, outlined when off (styles.css)
        markers: {
          width: 2,
          dash: 'solid',
          fill: (_u, i) => token(series[i - 1]?.color ?? 'ink-muted'),
          stroke: (_u, i) => token(series[i - 1]?.color ?? 'ink-muted'),
        },
      },
      cursor: { drag: { x: false, y: false } },
      hooks: {
        setSeries: [
          (u, i, o) => {
            const label = i === null ? undefined : u.series[i]?.label;
            if (typeof label !== 'string' || o.show === undefined) return;
            if (o.show) hidden.current.delete(label);
            else hidden.current.add(label);
          },
        ],
      },
      // times in UTC, like the rest of the dashboard and the alerts
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC'),
      scales: {
        x: { time: true },
        y: { range: (_u, min, max) => [yMin ?? Math.min(0, min), max > 0 ? max * 1.1 : 1] },
      },
      axes: [
        {
          stroke: muted,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
        },
        {
          stroke: muted,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
          values: (_u, vals) => vals.map((v) => format(v)),
          size: 60,
        },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          show: !hidden.current.has(s.label),
          stroke: token(s.color),
          width: s.dash ? 1 : 1.5,
          ...(s.dash ? { dash: [4, 4] } : {}),
          ...(s.fill ? { fill: token(s.fill) } : {}),
          points: { show: false },
          value: (_u: uPlot, v: number | null) => (v === null || v === undefined ? '–' : format(v)),
        })),
      ],
    };
    const plot = new uPlot(opts, [xs, ...series.map((s) => s.values)] as uPlot.AlignedData, el);
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [times, series, height, format, yMin]);
  return <div ref={ref} className="chart" />;
}
