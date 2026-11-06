import { api, type Incident as IncidentData } from '../api';
import { Card, CopyButton, Empty, ErrorBox, usePoll } from '../components/ui';
import { ago, ms, pct, when, KIND_LABEL } from '../format';
import { href } from '../router';

export function Incidents() {
  const [data, error] = usePoll(
    () => api<{ incidents: IncidentData[] }>('/v1/admin/incidents?limit=200'),
    [],
  );
  return (
    <>
      <div className="page-h">
        <h1>Incidents</h1>
      </div>
      <ErrorBox error={error} />
      {data && data.incidents.length === 0 && <Empty>No incidents yet.</Empty>}
      {data && data.incidents.length > 0 && (
        <table className="table" data-testid="incidents">
          <thead>
            <tr>
              <th>Status</th>
              <th>Provider</th>
              <th>Endpoints</th>
              <th>Opened</th>
              <th className="num">Duration</th>
              <th className="num">Peak errors</th>
            </tr>
          </thead>
          <tbody>
            {data.incidents.map((i) => (
              <tr
                key={i.id}
                className="clickable"
                onClick={() => (window.location.hash = href('incidents', i.id))}
              >
                <td>
                  <span className={`tag ${i.status === 'open' ? 'red' : ''}`}>{i.status}</span>
                  {i.alertsMuted && (
                    <span className="tag" title="opened during cooldown; no alerts sent">
                      muted
                    </span>
                  )}
                </td>
                <td>{i.provider}</td>
                <td>
                  {i.endpoints.map((e) => (
                    <div key={e.method + e.endpoint}>
                      <code>{e.method}</code> <code>{e.endpoint}</code>
                    </div>
                  ))}
                </td>
                <td title={when(i.openedAt)}>{ago(i.openedAt)}</td>
                <td className="num">{i.durationMinutes} min</td>
                <td className="num">
                  {i.kind === 'latency' ? ms(i.peakP95Ms) : pct(i.peakErrorRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function Incident({ id }: { id: string }) {
  const [inc, error] = usePoll(
    () => api<IncidentData>(`/v1/admin/incidents/${encodeURIComponent(id)}`),
    [id],
  );
  return (
    <>
      <div className="page-h">
        <h1>
          <a href={href('incidents')} className="muted">
            Incidents
          </a>{' '}
          / {inc ? inc.provider : id}
        </h1>
      </div>
      <ErrorBox error={error} />
      {inc && (
        <>
          <div className="kpis">
            <span className={`tag ${inc.status === 'open' ? 'red' : ''}`}>{inc.status}</span>
            <div>
              {inc.scope === 'provider' ? 'Provider-wide' : 'Single endpoint'},{' '}
              {KIND_LABEL[inc.kind] ?? inc.kind}
              {inc.windowMinutes && inc.windowMinutes > 5
                ? ` (low volume, judged over ${inc.windowMinutes} min)`
                : ''}
            </div>
            <div>opened {when(inc.openedAt)}</div>
            {inc.resolvedAt && <div>resolved {when(inc.resolvedAt)}</div>}
            <div>{inc.durationMinutes} min</div>
            {inc.alertsMuted && <span className="tag">muted (cooldown)</span>}
          </div>
          <Card
            title="Summary for the provider"
            actions={<CopyButton text={inc.summary} label="Copy summary" />}
          >
            <pre className="summary" data-testid="summary">
              {inc.summary}
            </pre>
          </Card>
          <Card title="Endpoints">
            <table className="table">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Since</th>
                  <th>Recovered</th>
                  <th className="num">Peak errors</th>
                </tr>
              </thead>
              <tbody>
                {inc.endpoints.map((e) => (
                  <tr key={e.method + e.endpoint}>
                    <td>
                      <a href={href('providers', inc.provider)}>
                        <code>{e.method}</code> <code>{e.endpoint}</code>
                      </a>
                    </td>
                    <td>{when(e.firstSeenAt)}</td>
                    <td>{e.recoveredAt ? when(e.recoveredAt) : '–'}</td>
                    <td className="num">{pct(e.peakErrorRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {inc.sampleRequestIds.length > 0 && (
            <Card
              title="Sample provider request IDs"
              actions={<CopyButton text={inc.sampleRequestIds.join('\n')} />}
            >
              <ul className="ids">
                {inc.sampleRequestIds.map((r) => (
                  <li key={r}>
                    <code>{r}</code>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </>
  );
}
