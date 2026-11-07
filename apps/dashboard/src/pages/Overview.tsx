import { api, type Overview as OverviewData, type ProviderHealth } from '../api';
import { Badge, Callout, Empty, ErrorBox, StatusDot, Table, usePoll } from '../components/ui';
import { ago, ms, num, pct } from '../format';
import { href } from '../router';

export function Overview({ environment }: { environment: string }) {
  const [data, error] = usePoll(
    () =>
      api<OverviewData>(
        `/v1/admin/overview${environment ? `?environment=${encodeURIComponent(environment)}` : ''}`,
      ),
    [environment],
  );
  const main = data?.providers.filter((p) => p.category !== 'infrastructure') ?? [];
  const infra = data?.providers.filter((p) => p.category === 'infrastructure') ?? [];
  return (
    <>
      <div className="page-h">
        <h1>Providers</h1>
        {data && (
          <span className="muted">
            last {data.windowMinutes} min · updated {data.minute.slice(11, 16)} UTC
          </span>
        )}
      </div>
      <ErrorBox error={error} />
      {data && data.openIncidents.length > 0 && (
        <Callout tone="danger" className="banner">
          {data.openIncidents.length} open incident{data.openIncidents.length > 1 ? 's' : ''}:{' '}
          {data.openIncidents.map((i) => (
            <a key={i.id} href={href('incidents', i.id)}>
              {i.provider} ({i.endpoints.filter((e) => !e.recoveredAt).length} endpoint
              {i.endpoints.filter((e) => !e.recoveredAt).length > 1 ? 's' : ''})
            </a>
          ))}
        </Callout>
      )}
      {data && data.providers.length === 0 && (
        <Empty>
          No traffic yet. Add the SDK to a service (see docs/nestjs-integration.md) and calls to
          your providers show up here within a minute.
        </Empty>
      )}
      {data && data.discovery.recent.length > 0 && (
        <Callout data-testid="discovered">
          <b>Discovered in the last 24 h:</b>{' '}
          {data.discovery.recent.map((p, i) => (
            <span key={p.name}>
              {i > 0 && ', '}
              <a href={href('providers', p.name)}>{p.label}</a>
            </span>
          ))}
          . Review them in <a href={href('settings', 'providers')}>Settings → Providers</a>.
        </Callout>
      )}
      {data?.discovery.overflow && (
        <Callout tone="danger">
          This project reached the provider limit; new hosts are collected under <b>Other</b>. Hide
          or merge providers you don't need.
        </Callout>
      )}
      {data && main.length > 0 && <ProviderTable providers={main} testId="providers" />}
      {data && infra.length > 0 && (
        <details className="infra">
          <summary>
            Infrastructure ({infra.length}){' '}
            <span className="muted">monitored, alerts off by default</span>
          </summary>
          <ProviderTable providers={infra} testId="infrastructure" />
        </details>
      )}
    </>
  );
}

const WEEK = 7 * 24 * 3600_000;

function ProviderTable({ providers, testId }: { providers: ProviderHealth[]; testId: string }) {
  return (
    <Table data-testid={testId}>
      <thead>
        <tr>
          <th>Provider</th>
          <th className="num">Score</th>
          <th className="num">Calls/min</th>
          <th className="num">Error rate</th>
          <th className="num">Normal</th>
          <th className="num">p95</th>
          <th className="num">Normal p95</th>
        </tr>
      </thead>
      <tbody>
        {providers.map((p) => (
          <tr key={p.name} className={p.status}>
            <td>
              <a href={href('providers', p.name)} className="provider-link">
                <StatusDot status={p.status} /> {p.label}
              </a>
              {p.source !== 'configured' &&
                p.firstSeenAt &&
                Date.now() - Date.parse(p.firstSeenAt) < WEEK && <Badge tone="healthy">New</Badge>}
              {!p.alertsEnabled && <Badge>alerts off</Badge>}
              {p.openIncidentId && (
                <Badge tone="danger" href={href('incidents', p.openIncidentId)}>
                  incident
                </Badge>
              )}
            </td>
            {p.callsPerMin === 0 ? (
              // no calls in the scoring window: when it was last called, no live numbers
              <>
                <td className="num">–</td>
                <td className="muted last-call" colSpan={5}>
                  {p.lastCallAt ? `last call ${ago(p.lastCallAt)}` : 'never called'}
                </td>
              </>
            ) : (
              <>
                <td className="num">{p.score ?? '–'}</td>
                <td className="num">{num(p.callsPerMin)}</td>
                <td
                  className={`num ${p.errorRate > p.normalErrorRate * 3 && p.errorRate > 0.01 ? 'bad' : ''}`}
                >
                  {pct(p.errorRate)}
                </td>
                <td className="num muted">{pct(p.normalErrorRate)}</td>
                <td className="num">{ms(p.p95Ms)}</td>
                <td className="num muted">{ms(p.normalP95Ms)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
