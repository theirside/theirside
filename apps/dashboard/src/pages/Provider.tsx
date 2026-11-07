import { useMemo, useState } from 'react';
import { api, type EndpointHealth, type Overview, type Range, type Series } from '../api';
import { Chart, type ChartSeries } from '../components/Chart';
import { Card, ErrorBox, Segmented, StatusDot, usePoll } from '../components/ui';
import { GROUP_LABEL, KIND_LABEL, ago, ms, num, pct } from '../format';
import { href } from '../router';

const OUTCOME_COLORS: Record<string, string> = {
  http_5xx: 'bad',
  timeout: 'chart-violet',
  conn_reset: 'chart-pink',
  conn_refused: 'ink',
  dns: 'chart-teal',
  tls: 'brand',
  http_4xx: 'warn',
  other_error: 'ink-muted',
};

const GROUP_COLORS: Record<string, string> = {
  outage: 'bad',
  auth: 'chart-violet',
  not_found: 'warn',
  validation: 'chart-teal',
  rate_limited: 'chart-pink',
  client_other: 'ink-muted',
};
const PALETTE = ['brand', 'chart-violet', 'chart-pink'];

function EndpointCharts({
  provider,
  ep,
  range,
  environment,
}: {
  provider: string;
  ep: EndpointHealth;
  range: Range;
  environment: string;
}) {
  const qs = new URLSearchParams({
    provider,
    endpoint: ep.endpoint,
    method: ep.method,
    range,
    environment: environment || ep.environment,
  });
  const [series, error] = usePoll(
    () => api<Series>(`/v1/admin/series?${qs}`),
    [qs.toString()],
    30_000,
  );
  const charts = useMemo(() => {
    if (!series) return null;
    const times = series.points.map((p) => p.t);
    const b = series.baseline;
    const outcomes = [...new Set(series.points.flatMap((p) => Object.keys(p.outcomeRates)))];
    const errorSeries: ChartSeries[] = [
      ...outcomes.map((o) => ({
        label: o,
        values: series.points.map((p) => (p.calls > 0 ? (p.outcomeRates[o] ?? 0) : null)),
        color: OUTCOME_COLORS[o] ?? 'ink-muted',
      })),
    ];
    if (b) {
      errorSeries.push({
        label: 'normal',
        values: times.map(() => b.errorRate),
        color: 'ok',
        dash: true,
      });
      errorSeries.push({
        label: 'incident threshold',
        values: times.map(() => b.errorThreshold),
        color: 'bad',
        dash: true,
      });
    }
    // status mix: each failure group present, with its normal share dashed
    const groups = [
      ...new Set([
        ...series.points.flatMap((p) => Object.keys(p.statusMix ?? {})),
        ...Object.keys(b?.statusMix ?? {}).filter((g) => (b?.statusMix[g] ?? 0) > 0),
      ]),
    ];
    const mix: ChartSeries[] = groups.flatMap((g, i) => {
      const color = GROUP_COLORS[g] ?? PALETTE[i % PALETTE.length]!;
      const line: ChartSeries = {
        label: GROUP_LABEL[g] ?? g,
        values: series.points.map((p) => (p.calls > 0 ? (p.statusMix?.[g] ?? 0) : null)),
        color,
      };
      const normal = b?.statusMix?.[g];
      return normal && normal > 0
        ? [
            line,
            {
              label: `normal ${GROUP_LABEL[g] ?? g}`,
              values: times.map(() => normal),
              color,
              dash: true,
            },
          ]
        : [line];
    });
    const latency: ChartSeries[] = [
      { label: 'p50', values: series.points.map((p) => p.p50Ms), color: 'brand' },
      { label: 'p95', values: series.points.map((p) => p.p95Ms), color: 'warn' },
    ];
    if (b?.p95Ms)
      latency.push({
        label: 'normal p95',
        values: times.map(() => b.p95Ms),
        color: 'ok',
        dash: true,
      });
    return {
      times,
      calls: [
        {
          label: 'calls/min',
          values: series.points.map((p) => p.callsPerMin),
          color: 'brand',
          fill: 'brand-wash',
        },
      ],
      errors: errorSeries,
      mix,
      latency,
    };
  }, [series]);
  return (
    <div className="charts">
      <ErrorBox error={error} />
      {charts && (
        <>
          <div>
            <h3>Calls per minute</h3>
            <Chart times={charts.times} series={charts.calls} format={(v) => num(v)} />
          </div>
          <div>
            <h3>
              Error rate by outcome{' '}
              {series?.baseline?.learning ? <span className="tag">learning</span> : null}
            </h3>
            <Chart times={charts.times} series={charts.errors} format={(v) => pct(v)} />
          </div>
          <div data-testid="status-mix">
            <h3>Status mix (share of calls, dashed: normal)</h3>
            {charts.mix.length > 0 ? (
              <Chart times={charts.times} series={charts.mix} format={(v) => pct(v)} />
            ) : (
              <div className="empty">Every call succeeded in this range.</div>
            )}
          </div>
          <div>
            <h3>Latency p50 / p95</h3>
            <Chart times={charts.times} series={charts.latency} format={(v) => ms(v)} />
          </div>
        </>
      )}
    </div>
  );
}

export function Provider({ name, environment }: { name: string; environment: string }) {
  const [range, setRange] = useState<Range>('1h');
  const [open, setOpen] = useState<string | null>(null);
  // endpoints called within the range stay listed; quiet ones come back as idle
  const qs = new URLSearchParams({
    provider: name,
    range,
    ...(environment ? { environment } : {}),
  });
  const [data, error] = usePoll(() => api<Overview>(`/v1/admin/overview?${qs}`), [qs.toString()]);
  // a response for the previous range can land after a switch: show only the current one
  const p = data?.range === range ? data.providers.find((x) => x.name === name) : undefined;
  const idle = p?.endpoints.filter((e) => e.status === 'idle').length ?? 0;
  const key = (e: EndpointHealth) => `${e.environment} ${e.method} ${e.endpoint}`;
  return (
    <>
      <div className="page-h">
        <h1>
          <a href={href()} className="muted">
            Providers
          </a>{' '}
          / {p?.label ?? name}{' '}
          <a
            href={href('settings', 'providers', name)}
            className="tag"
            title="Rename, merge, hide, alerts and thresholds"
          >
            manage
          </a>
        </h1>
        <Segmented value={range} options={['1h', '24h', '7d']} onChange={setRange} />
      </div>
      <ErrorBox error={error} />
      {p && (
        <div className="kpis">
          <div>
            <StatusDot status={p.status} label />
          </div>
          {p.callsPerMin === 0 ? (
            // nothing in the scoring window: when it was last called, no live numbers
            <div className="muted" data-testid="provider-last-call">
              {p.lastCallAt ? `last call ${ago(p.lastCallAt)}` : 'never called'}
            </div>
          ) : (
            <>
              <div>
                <b>{p.score ?? '–'}</b> score
              </div>
              <div>
                <b>{num(p.callsPerMin)}</b> calls/min
              </div>
              <div>
                <b>{pct(p.errorRate)}</b> errors{' '}
                <span className="muted">(normal {pct(p.normalErrorRate)})</span>
              </div>
              <div>
                <b>{ms(p.p95Ms)}</b> p95
              </div>
            </>
          )}
          {p.openIncidentId && (
            <a className="tag red" href={href('incidents', p.openIncidentId)}>
              open incident
            </a>
          )}
        </div>
      )}
      {p && (
        <Card
          title="Endpoints"
          actions={
            <span className="muted">
              {idle > 0 &&
                `idle: no calls in the last ${data!.windowMinutes} min, totals over ${range} · `}
              click a row for charts
            </span>
          }
        >
          <table className="table" data-testid="endpoints">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th className="num">Score</th>
                <th className="num">Calls/min</th>
                <th className="num">Errors</th>
                <th className="num">Normal</th>
                <th className="num">4xx</th>
                <th className="num">429</th>
                <th className="num">p95</th>
                <th className="num">Normal p95</th>
              </tr>
            </thead>
            <tbody>
              {p.endpoints.map((e) => (
                <FragmentRow
                  key={key(e)}
                  e={e}
                  range={range}
                  open={open === key(e)}
                  onToggle={() => setOpen(open === key(e) ? null : key(e))}
                >
                  <EndpointCharts provider={name} ep={e} range={range} environment={environment} />
                </FragmentRow>
              ))}
            </tbody>
          </table>
          {p.endpoints.length === 0 && (
            <div className="empty">
              No calls in the last {range}
              {p.lastCallAt ? ` (last call ${ago(p.lastCallAt)})` : ''}.
            </div>
          )}
        </Card>
      )}
      {data?.range === range && !p && <div className="empty">No data for {name}.</div>}
    </>
  );
}

function FragmentRow({
  e,
  range,
  open,
  onToggle,
  children,
}: {
  e: EndpointHealth;
  range: Range;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const idle = e.status === 'idle';
  return (
    <>
      <tr
        className={`clickable ${e.status}`}
        onClick={onToggle}
        title={
          idle ? `No calls in the scoring window; numbers are totals over ${range}` : undefined
        }
      >
        <td>
          <StatusDot status={e.status} /> <code>{e.method}</code> <code>{e.endpoint}</code>
          {idle && <span className="tag">idle</span>}
          {e.learning && !idle && <span className="tag">learning</span>}
          {e.incidentKind && (
            <span className="tag red" data-testid="incident-kind">
              {KIND_LABEL[e.incidentKind] ?? e.incidentKind}
            </span>
          )}
          {e.inIncident && idle && <span className="tag red">open incident</span>}
          {e.environment !== 'production' && <span className="tag">{e.environment}</span>}
          {idle && <span className="muted last-call"> last call {ago(e.lastCallAt)}</span>}
        </td>
        {idle ? (
          <>
            <td className="num">–</td>
            <td className="num">
              {num(e.rangeTotals.calls)} <span className="muted">in {range}</span>
            </td>
            <td className="num">{pct(e.rangeTotals.errorRate)}</td>
            <td className="num muted">{pct(e.normalErrorRate)}</td>
            <td className="num">–</td>
            <td className="num">–</td>
            <td className="num">{ms(e.rangeTotals.p95Ms)}</td>
            <td className="num muted">{ms(e.normalP95Ms)}</td>
          </>
        ) : (
          <>
            <td className="num">{e.score ?? '–'}</td>
            <td className="num">{num(e.callsPerMin)}</td>
            <td className={`num ${e.inIncident ? 'bad' : ''}`}>{pct(e.errorRate)}</td>
            <td className="num muted">{pct(e.normalErrorRate)}</td>
            <td className="num">{pct(e.rate4xx)}</td>
            <td className="num">{pct(e.rate429)}</td>
            <td className="num">{ms(e.p95Ms)}</td>
            <td className="num muted">{ms(e.normalP95Ms)}</td>
          </>
        )}
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={9}>{children}</td>
        </tr>
      )}
    </>
  );
}
