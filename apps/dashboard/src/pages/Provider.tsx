import { useMemo, useState } from 'react';
import { api, type EndpointHealth, type Overview, type Series } from '../api';
import { Chart, type ChartSeries } from '../components/Chart';
import { Card, ErrorBox, Segmented, StatusDot, usePoll } from '../components/ui';
import { ms, num, pct } from '../format';
import { href } from '../router';

type Range = '1h' | '24h' | '7d';

const OUTCOME_COLORS: Record<string, string> = {
  http_5xx: '#d64545',
  timeout: '#9b59b6',
  conn_reset: '#e67e22',
  conn_refused: '#c0392b',
  dns: '#16a085',
  tls: '#2c3e50',
  http_4xx: '#d98b06',
  other_error: '#7f8c8d',
};

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
        color: OUTCOME_COLORS[o] ?? '#888',
      })),
    ];
    if (b) {
      errorSeries.push({
        label: 'normal',
        values: times.map(() => b.errorRate),
        color: '#1f9d55',
        dash: true,
      });
      errorSeries.push({
        label: 'incident threshold',
        values: times.map(() => b.errorThreshold),
        color: '#d64545',
        dash: true,
      });
    }
    const latency: ChartSeries[] = [
      { label: 'p50', values: series.points.map((p) => p.p50Ms), color: '#3b82f6' },
      { label: 'p95', values: series.points.map((p) => p.p95Ms), color: '#9b59b6' },
    ];
    if (b?.p95Ms)
      latency.push({
        label: 'normal p95',
        values: times.map(() => b.p95Ms),
        color: '#1f9d55',
        dash: true,
      });
    return {
      times,
      calls: [
        {
          label: 'calls/min',
          values: series.points.map((p) => p.callsPerMin),
          color: '#3b82f6',
          fill: 'rgba(59,130,246,0.12)',
        },
      ],
      errors: errorSeries,
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
  const [data, error] = usePoll(
    () =>
      api<Overview>(
        `/v1/admin/overview${environment ? `?environment=${encodeURIComponent(environment)}` : ''}`,
      ),
    [environment],
  );
  const p = data?.providers.find((x) => x.name === name);
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
            href={href('settings', 'providers')}
            className="tag"
            title="Rename, merge, hide, alerts"
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
          {p.openIncidentId && (
            <a className="tag red" href={href('incidents', p.openIncidentId)}>
              open incident
            </a>
          )}
        </div>
      )}
      {p && (
        <Card title="Endpoints" actions={<span className="muted">click a row for charts</span>}>
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
                  open={open === key(e)}
                  onToggle={() => setOpen(open === key(e) ? null : key(e))}
                >
                  <EndpointCharts provider={name} ep={e} range={range} environment={environment} />
                </FragmentRow>
              ))}
            </tbody>
          </table>
          {p.endpoints.length === 0 && (
            <div className="empty">No calls in the last few minutes.</div>
          )}
        </Card>
      )}
      {data && !p && <div className="empty">No data for {name}.</div>}
    </>
  );
}

function FragmentRow({
  e,
  open,
  onToggle,
  children,
}: {
  e: EndpointHealth;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr className={`clickable ${e.status}`} onClick={onToggle}>
        <td>
          <StatusDot status={e.status} /> <code>{e.method}</code> <code>{e.endpoint}</code>
          {e.learning && <span className="tag">learning</span>}
          {e.environment !== 'production' && <span className="tag">{e.environment}</span>}
        </td>
        <td className="num">{e.score ?? '–'}</td>
        <td className="num">{num(e.callsPerMin)}</td>
        <td className={`num ${e.inIncident ? 'bad' : ''}`}>{pct(e.errorRate)}</td>
        <td className="num muted">{pct(e.normalErrorRate)}</td>
        <td className="num">{pct(e.rate4xx)}</td>
        <td className="num">{pct(e.rate429)}</td>
        <td className="num">{ms(e.p95Ms)}</td>
        <td className="num muted">{ms(e.normalP95Ms)}</td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={9}>{children}</td>
        </tr>
      )}
    </>
  );
}
