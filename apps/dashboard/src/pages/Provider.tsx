import { useMemo, useState } from 'react';
import {
  api,
  type EndpointHealth,
  type Incident,
  type Overview,
  type Provider as ProviderConfig,
  type Range,
  type Series,
} from '../api';
import { Chart, type ChartSeries } from '../components/Chart';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Segmented,
  StatusDot,
  Table,
  usePoll,
} from '../components/ui';
import { GROUP_LABEL, KIND_LABEL, ago, ms, num, pct } from '../format';
import { href } from '../router';
import { EXPECTABLE_STATUSES, ExpectedMarks, MarkExpected, STATUSES_OF_KIND } from './Expected';
import { IncidentTable } from './Incidents';
import { WebhooksSection } from './Webhooks';

/** The endpoint table column an open incident of this kind is about (highlighted). */
export type CauseColumn = 'errors' | '4xx' | '429' | 'p95';
export function causeColumn(kind: string | null): CauseColumn | null {
  switch (kind) {
    case 'errors':
      return 'errors';
    case 'auth':
    case 'not_found':
    case 'validation':
    case 'behaviour':
      return '4xx';
    case 'rate_limited':
      return '429';
    case 'latency':
      return 'p95';
    default:
      return null;
  }
}

// series colours are tokens (packages/design): chart-1 blue, -2 pink, -3 purple, -4 teal,
// -5 amber, -6 red, -7 green, -8 grey
const OUTCOME_COLORS: Record<string, string> = {
  http_5xx: 'var(--chart-6)',
  timeout: 'var(--chart-3)',
  conn_reset: 'var(--chart-2)',
  conn_refused: 'var(--chart-4)',
  dns: 'var(--chart-1)',
  tls: 'var(--color-text-secondary)',
  http_4xx: 'var(--chart-5)',
  other_error: 'var(--chart-8)',
};

const GROUP_COLORS: Record<string, string> = {
  outage: 'var(--chart-6)',
  auth: 'var(--chart-3)',
  not_found: 'var(--chart-5)',
  validation: 'var(--chart-4)',
  rate_limited: 'var(--chart-2)',
  client_other: 'var(--chart-8)',
};
const PALETTE = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-2)'];
const NORMAL = 'var(--color-healthy)';
const THRESHOLD = 'var(--color-danger)';

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
        color: OUTCOME_COLORS[o] ?? 'var(--chart-8)',
      })),
    ];
    if (b) {
      errorSeries.push({
        label: 'normal',
        values: times.map(() => b.errorRate),
        color: NORMAL,
        dash: true,
      });
      errorSeries.push({
        label: 'incident threshold',
        values: times.map(() => b.errorThreshold),
        color: THRESHOLD,
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
    // answers that are normal business answers: tagged in code (per reason), marked here (per status)
    const reasons = [...new Set(series.points.flatMap((p) => Object.keys(p.expected ?? {})))];
    const markedStatuses = [...new Set(series.points.flatMap((p) => Object.keys(p.marked ?? {})))];
    const expected: ChartSeries[] = [
      ...reasons.map((r, i) => ({
        label: r,
        values: series.points.map((p) => (p.calls > 0 ? (p.expected?.[r] ?? 0) : null)),
        color: PALETTE[i % PALETTE.length]!,
      })),
      ...markedStatuses.map((st, i) => ({
        label: `${st} (marked expected)`,
        values: series.points.map((p) => (p.calls > 0 ? (p.marked?.[st] ?? 0) : null)),
        color: ['var(--chart-4)', 'var(--chart-5)', 'var(--chart-8)'][i % 3]!,
        dash: true,
      })),
    ];
    const latency: ChartSeries[] = [
      { label: 'p50', values: series.points.map((p) => p.p50Ms), color: 'var(--chart-1)' },
      {
        label: 'p95',
        values: series.points.map((p) => p.p95Ms),
        color: 'var(--chart-3)',
      },
    ];
    if (b?.p95Ms)
      latency.push({
        label: 'normal p95',
        values: times.map(() => b.p95Ms),
        color: NORMAL,
        dash: true,
      });
    return {
      times,
      calls: [
        {
          label: 'calls/min',
          values: series.points.map((p) => p.callsPerMin),
          color: 'var(--chart-1)',
          fillAlpha: 0.12,
        },
      ],
      errors: errorSeries,
      mix,
      expected,
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
              Error rate by outcome {series?.baseline?.learning ? <Badge>learning</Badge> : null}
            </h3>
            <Chart times={charts.times} series={charts.errors} format={(v) => pct(v)} />
          </div>
          <div>
            <h3>Latency p50 / p95</h3>
            <Chart times={charts.times} series={charts.latency} format={(v) => ms(v)} />
          </div>
          <div data-testid="status-mix">
            <h3>Status mix (share of calls, dashed: normal)</h3>
            {charts.mix.length > 0 ? (
              <Chart times={charts.times} series={charts.mix} format={(v) => pct(v)} />
            ) : (
              <div className="empty">Every call succeeded in this range.</div>
            )}
          </div>
          {charts.expected.length > 0 && (
            <div data-testid="expected-chart">
              <h3>
                Expected answers (share of calls, counted as successful; solid: marked in code,
                dashed: marked here)
              </h3>
              <Chart times={charts.times} series={charts.expected} format={(v) => pct(v)} />
            </div>
          )}
        </>
      )}
      <ExpectedControls provider={provider} ep={ep} />
    </div>
  );
}

/** Mark a status as expected for this endpoint (folded away until asked for). */
function ExpectedControls({ provider, ep }: { provider: string; ep: EndpointHealth }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="expected-controls">
      {open ? (
        <MarkExpected
          provider={provider}
          ep={ep}
          // an open status-class incident's statuses first
          statuses={[
            ...new Set([
              ...((ep.incidentKind && STATUSES_OF_KIND[ep.incidentKind]) || []),
              ...EXPECTABLE_STATUSES,
            ]),
          ]}
          marked={ep.expectedStatuses ?? []}
          autoFocus
        />
      ) : (
        <Button type="button" size="small" onClick={() => setOpen(true)}>
          A status here is a normal answer…
        </Button>
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
          <Badge
            href={href('settings', 'providers', name)}
            title="Rename, merge, hide, alerts and thresholds"
          >
            manage
          </Badge>
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
            <Badge tone="danger" href={href('incidents', p.openIncidentId)}>
              open incident
            </Badge>
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
          <Table data-testid="endpoints">
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
                  provider={name}
                  e={e}
                  range={range}
                  open={open === key(e)}
                  onToggle={() => setOpen(open === key(e) ? null : key(e))}
                >
                  <EndpointCharts provider={name} ep={e} range={range} environment={environment} />
                </FragmentRow>
              ))}
            </tbody>
          </Table>
          {p.endpoints.length === 0 && (
            <div className="empty">
              No calls in the last {range}
              {p.lastCallAt ? ` (last call ${ago(p.lastCallAt)})` : ''}.
            </div>
          )}
        </Card>
      )}
      {data?.range === range && !p && <div className="empty">No outgoing calls to {name}.</div>}
      <WebhooksSection provider={name} environment={environment} range={range} />
      <ProviderShared name={name} />
    </>
  );
}

/**
 * What outgoing calls and webhooks of one provider share: one alerts switch, one support
 * contact, and its incidents from both directions.
 */
function ProviderShared({ name }: { name: string }) {
  const [providers, , reload] = usePoll(
    () => api<{ providers: ProviderConfig[] }>('/v1/admin/providers'),
    [],
    60_000,
  );
  const [incidents, error] = usePoll(
    () =>
      api<{ incidents: Incident[] }>(
        `/v1/admin/incidents?provider=${encodeURIComponent(name)}&limit=10`,
      ),
    [name],
  );
  const [saving, setSaving] = useState(false);
  const cfg = providers?.providers.find((x) => x.name === name);
  const setAlerts = async (alertsEnabled: boolean) => {
    if (!cfg) return;
    setSaving(true);
    try {
      await api(`/v1/admin/providers/${encodeURIComponent(cfg.id)}`, {
        method: 'PATCH',
        body: { alertsEnabled },
      });
      reload();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="Alerts, support and incidents" data-testid="provider-shared">
      <ErrorBox error={error} />
      {cfg && (
        <div className="provider-shared">
          <label className="field check">
            <input
              type="checkbox"
              checked={cfg.alertsEnabled}
              disabled={saving}
              onChange={(e) => void setAlerts(e.target.checked)}
            />{' '}
            Alerts on, for outgoing calls and webhooks
          </label>
          <div>
            <span className="muted">Support: </span>
            {cfg.supportEmail || cfg.supportUrl ? (
              <>
                {cfg.supportEmail && <a href={`mailto:${cfg.supportEmail}`}>{cfg.supportEmail}</a>}
                {cfg.supportEmail && cfg.supportUrl && ' · '}
                {cfg.supportUrl && (
                  <a href={cfg.supportUrl} target="_blank" rel="noreferrer">
                    {cfg.supportUrl}
                  </a>
                )}
              </>
            ) : (
              <a href={href('settings', 'providers', name)}>add a support contact</a>
            )}
            <span className="muted"> (in alerts and incident summaries)</span>
          </div>
        </div>
      )}
      {incidents && incidents.incidents.length > 0 ? (
        <IncidentTable incidents={incidents.incidents} testId="provider-incidents" />
      ) : (
        incidents && <div className="empty">No incidents for {cfg?.displayName ?? name}.</div>
      )}
    </Card>
  );
}

function FragmentRow({
  provider,
  e,
  range,
  open,
  onToggle,
  children,
}: {
  provider: string;
  e: EndpointHealth;
  range: Range;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const idle = e.status === 'idle';
  // an open incident whose current window is healthy: say so instead of a plain red badge
  const recovering = !idle && e.inIncident && !!e.recovering;
  const status = recovering ? 'amber' : e.status;
  // the column the open incident is about; the others stay uncoloured
  const cause = e.inIncident && !recovering ? causeColumn(e.incidentKind) : null;
  const bad = (c: CauseColumn) => (cause === c ? 'bad' : '');
  const [marks, setMarks] = useState<number[] | null>(null);
  const expected = marks ?? e.expectedStatuses ?? [];
  return (
    <>
      <tr
        className={`clickable ${status}`}
        onClick={onToggle}
        title={
          idle ? `No calls in the scoring window; numbers are totals over ${range}` : undefined
        }
      >
        <td>
          <StatusDot status={status} /> <code>{e.method}</code> <code>{e.endpoint}</code>
          {idle && <Badge>idle</Badge>}
          {e.learning && !idle && <Badge>learning</Badge>}
          {recovering ? (
            <Badge
              tone="warning"
              data-testid="recovering"
              title="The incident resolves after 10 healthy minutes in a row"
            >
              recovering
              {e.lastBadMinuteAt ? ` · last bad minute ${ago(e.lastBadMinuteAt)}` : ''}
            </Badge>
          ) : (
            e.incidentKind && (
              <Badge tone="danger" data-testid="incident-kind">
                {KIND_LABEL[e.incidentKind] ?? e.incidentKind}
              </Badge>
            )
          )}
          <ExpectedMarks provider={provider} ep={e} statuses={expected} onChange={setMarks} />
          {(e.expectedRate ?? 0) > 0 && !idle && (
            <Badge title="Answers your code marked expected (markExpected): counted as successful">
              {pct(e.expectedRate!)} expected
            </Badge>
          )}
          {e.inIncident && idle && <Badge tone="danger">open incident</Badge>}
          {e.environment !== 'production' && <Badge>{e.environment}</Badge>}
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
            <td className={`num ${bad('errors')}`} data-col="errors">
              {pct(e.errorRate)}
            </td>
            <td className="num muted">{pct(e.normalErrorRate)}</td>
            <td className={`num ${bad('4xx')}`} data-col="4xx">
              {pct(e.rate4xx)}
            </td>
            <td className={`num ${bad('429')}`} data-col="429">
              {pct(e.rate429)}
            </td>
            <td className={`num ${bad('p95')}`} data-col="p95">
              {ms(e.p95Ms)}
            </td>
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
