import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  type Range,
  type WebhookCandidate,
  type WebhookCandidatesResponse,
  type WebhookProvider,
  type WebhookSeries,
  type WebhookSource,
  type WebhooksResponse,
} from '../api';
import { Chart, type ChartSeries } from '../components/Chart';
import {
  Badge,
  Button,
  Callout,
  Card,
  Empty,
  ErrorBox,
  Segmented,
  Table,
  usePoll,
} from '../components/ui';
import { KIND_LABEL, ago, lag, ms, num, pct } from '../format';
import { href } from '../router';
import { useIsAdmin } from '../role';
import { ConfirmRoute, titleCase } from './ConfirmRoute';

const NORMAL = 'var(--color-healthy)';

/**
 * Inbound webhooks: every source (provider + route) with its last delivery,
 * deliveries in the last hour against the learned rate for this hour of the
 * week, rejected share, handler p95 and delivery lag. `provider` limits it to
 * one provider (the provider page); without it, the Webhooks page.
 */
export function WebhooksSection({
  provider,
  environment,
  range,
  showProvider,
  empty,
  reloadKey,
}: {
  provider?: string;
  environment: string;
  range: Range;
  showProvider?: boolean;
  /** Shown when nothing is monitored (the Webhooks page); default: a one-line hint. */
  empty?: ReactNode;
  /** Changes when a route was confirmed elsewhere on the page: load again at once. */
  reloadKey?: number;
}) {
  const qs = new URLSearchParams({
    range,
    ...(provider ? { provider } : {}),
    ...(environment ? { environment } : {}),
  });
  const [data, error, reload] = usePoll(
    () => api<WebhooksResponse>(`/v1/admin/webhooks?${qs}`),
    [qs.toString(), reloadKey ?? 0],
  );
  if (error) return <ErrorBox error={error} />;
  if (!data || data.range !== range) return null;
  if (data.providers.length === 0) return provider ? null : (empty ?? <Empty>{NO_WEBHOOKS}</Empty>);
  return (
    <>
      {data.allQuiet && (
        <Callout tone="warning">
          All sources quiet: possible holiday or receiver issue. Every webhook source of this
          project has gone silent at once, so silence alerts are held until one delivers again.
          Check that the receiving service is running and reachable.
        </Callout>
      )}
      {data.providers.map((p) => (
        <ProviderWebhooks
          key={p.provider}
          p={p}
          range={range}
          environment={environment}
          showProvider={showProvider ?? false}
          onChanged={reload}
        />
      ))}
    </>
  );
}

const NO_WEBHOOKS =
  'No webhooks received yet. The SDK records deliveries from known senders (Stripe, GitHub, Shopify, Slack, Svix and others) automatically; declare other routes with init({ webhooks: [{ path, provider }] }).';

function ProviderWebhooks({
  p,
  range,
  environment,
  showProvider,
  onChanged,
}: {
  p: WebhookProvider;
  range: Range;
  environment: string;
  showProvider: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const label = p.displayName ?? p.provider;
  const title = showProvider ? (
    <a href={href('providers', p.provider)}>{label} webhooks</a>
  ) : (
    'Webhooks'
  );
  const key = (s: WebhookSource) => `${s.environment} ${s.endpoint}`;
  return (
    <Card
      title={title}
      data-testid="webhooks"
      actions={
        <span className="muted">
          {!p.alertsEnabled && <Badge>alerts off</Badge>} last hour vs normal · {range} totals ·
          click a row for charts
        </span>
      }
    >
      <Table>
        <thead>
          <tr>
            <th>Route</th>
            <th>Last delivery</th>
            <th className="num">Deliveries/h</th>
            <th className="num">Normal/h</th>
            <th className="num">Rejected</th>
            <th className="num">Normal</th>
            <th className="num">Handler p95</th>
            <th className="num">Lag p95</th>
            <th>Expected quiet</th>
          </tr>
        </thead>
        <tbody>
          {p.sources.map((s) =>
            s.status === 'waiting' ? (
              <WaitingRow key={`waiting ${s.endpoint}`} s={s} />
            ) : (
              <Fragment key={key(s)}>
                <SourceRow
                  provider={p.provider}
                  s={s}
                  onToggle={() => setOpen(open === key(s) ? null : key(s))}
                  onChanged={onChanged}
                />
                {open === key(s) && (
                  <tr className="detail">
                    <td colSpan={9}>
                      <SourceCharts
                        provider={p.provider}
                        s={s}
                        range={range}
                        environment={environment || s.environment}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ),
          )}
        </tbody>
      </Table>
    </Card>
  );
}

const STATUS_BADGE: Record<WebhookSource['status'], { text: string; tone?: 'danger' } | null> = {
  incident: null,
  waiting: { text: 'waiting for the first delivery' },
  quiet: { text: 'expected quiet' },
  learning: { text: 'learning' },
  irregular: { text: 'irregular: silence alerts off' },
  all_quiet: { text: 'all sources quiet: silence held' },
  ok: null,
};

const IRREGULAR_HELP =
  'Its normal gaps between deliveries are too irregular to tell an outage from a pause (for example traffic driven by tests or batch jobs), so silence is not judged. Rejections, slowness and lag still alert.';

/** "45 min", "2 h 10 min", "1 d 4 h". */
const gap = (m: number) =>
  m < 60
    ? `${Math.round(m)} min`
    : m < 1440
      ? `${Math.floor(m / 60)} h${m % 60 ? ` ${Math.round(m % 60)} min` : ''}`
      : `${Math.floor(m / 1440)} d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)} h` : ''}`;

/** A route confirmed a moment ago: monitored from its first delivery, no numbers yet. */
function WaitingRow({ s }: { s: WebhookSource }) {
  return (
    <tr data-testid="waiting-route">
      <td>
        <code>POST</code> <code>{s.endpoint}</code> <Badge>waiting for the first delivery</Badge>
      </td>
      <td colSpan={8} className="muted">
        Confirmed. The SDK records it from its next settings refresh (within a minute), then it is
        judged like every route here.
      </td>
    </tr>
  );
}

function SourceRow({
  provider,
  s,
  onToggle,
  onChanged,
}: {
  provider: string;
  s: WebhookSource;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const save = async (body: { expectedQuiet?: boolean; silenceForced?: boolean }) => {
    setSaving(true);
    try {
      await api('/v1/admin/webhooks/sources', {
        method: 'PUT',
        body: { environment: s.environment, provider, endpoint: s.endpoint, ...body },
      });
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  const toggleQuiet = (expectedQuiet: boolean) => save({ expectedQuiet });
  const badge = STATUS_BADGE[s.status];
  const below =
    s.normalPerHour !== null && s.normalPerHour >= 1 && s.deliveriesPerHour < s.normalPerHour / 3;
  return (
    <tr className="clickable" onClick={onToggle}>
      <td>
        <code>POST</code> <code>{s.endpoint}</code>{' '}
        {s.incident && (
          <Badge tone="danger" href={href('incidents', s.incident.id)}>
            {KIND_LABEL[s.incident.kind] ?? s.incident.kind}
          </Badge>
        )}
        {badge && (
          <Badge title={s.status === 'irregular' ? IRREGULAR_HELP : undefined}>{badge.text}</Badge>
        )}
        {s.silenceIrregular && s.silenceForced && !s.expectedQuiet && (
          <Badge title={IRREGULAR_HELP}>irregular: silence alerts on</Badge>
        )}
        {s.silenceIrregular && !s.expectedQuiet && (
          <span onClick={(e) => e.stopPropagation()}>
            {' '}
            <Button
              size="small"
              disabled={saving}
              title={
                s.silenceForced
                  ? 'Back to no silence alerts for this irregular route'
                  : `Alert when this route is silent for longer than 1.5× its longest normal gap${s.longestNormalGapMinutes ? ` (${gap(s.longestNormalGapMinutes)} in the last 4 weeks)` : ''}, weighed by its usual rate at those times`
              }
              onClick={() => void save({ silenceForced: !s.silenceForced })}
            >
              {s.silenceForced ? 'Turn silence alerts off' : 'Alert on silence anyway'}
            </Button>
          </span>
        )}
        {s.environment !== 'production' && <Badge>{s.environment}</Badge>}
      </td>
      <td title={s.lastService ? `received by ${s.lastService}` : undefined}>
        {ago(s.lastDeliveryAt)}
      </td>
      <td className={`num ${below ? 'bad' : ''}`}>{num(s.deliveriesPerHour)}</td>
      <td className="num muted">{s.normalPerHour === null ? '–' : `~${num(s.normalPerHour)}`}</td>
      <td className={`num ${s.incident?.kind === 'webhook_rejections' ? 'bad' : ''}`}>
        {pct(s.rejectionRate)}
        {s.authRate !== null && s.authRate > 0 && (
          <span className="muted"> ({pct(s.authRate)} 401/403)</span>
        )}
      </td>
      <td className="num muted">{pct(s.normalRejectionRate)}</td>
      <td className="num">
        {ms(s.p95Ms)} <span className="muted">({ms(s.normalP95Ms)})</span>
      </td>
      <td className="num">
        {lag(s.lagP95S)} <span className="muted">({lag(s.normalLagP95S)})</span>
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`${s.endpoint}: expected quiet (no silence alerts)`}
          title="No silence alerts for this route (rejections, slowness and lag still alert)"
          checked={s.expectedQuiet}
          disabled={saving}
          onChange={(e) => void toggleQuiet(e.target.checked)}
        />
      </td>
    </tr>
  );
}

function SourceCharts({
  provider,
  s,
  range,
  environment,
}: {
  provider: string;
  s: WebhookSource;
  range: Range;
  environment: string;
}) {
  const qs = new URLSearchParams({ provider, endpoint: s.endpoint, environment, range });
  const [series, error] = usePoll(
    () => api<WebhookSeries>(`/v1/admin/webhooks/series?${qs}`),
    [qs.toString()],
    30_000,
  );
  const charts = useMemo(() => {
    if (!series) return null;
    const times = series.points.map((p) => p.t);
    const deliveries: ChartSeries[] = [
      {
        label: `deliveries per ${series.bucketMinutes} min`,
        values: series.points.map((p) => p.deliveries),
        color: 'var(--chart-1)',
        fillAlpha: 0.12,
      },
    ];
    if (series.points.some((p) => p.expected !== null))
      deliveries.push({
        label: 'normal for the hour of the week',
        values: series.points.map((p) => p.expected),
        color: NORMAL,
        dash: true,
      });
    return {
      times,
      deliveries,
      rejected: [
        {
          label: 'rejected share',
          values: series.points.map((p) => p.rejectionRate),
          color: 'var(--chart-6)',
        },
      ] as ChartSeries[],
      handler: [
        {
          label: 'handler p95',
          values: series.points.map((p) => p.p95Ms),
          color: 'var(--chart-3)',
        },
      ] as ChartSeries[],
      lag: [
        {
          label: 'lag p95 (s)',
          values: series.points.map((p) => p.lagP95S),
          color: 'var(--chart-4)',
        },
      ] as ChartSeries[],
    };
  }, [series]);
  return (
    <div className="charts">
      <ErrorBox error={error} />
      {charts && (
        <>
          <div>
            <h3>Deliveries (dashed: normal for this time of week)</h3>
            <Chart times={charts.times} series={charts.deliveries} format={(v) => num(v)} />
          </div>
          <div>
            <h3>Rejected by our app</h3>
            <Chart times={charts.times} series={charts.rejected} format={(v) => pct(v)} />
          </div>
          <div>
            <h3>Handler duration p95</h3>
            <Chart times={charts.times} series={charts.handler} format={(v) => ms(v)} />
          </div>
          <div>
            <h3>Delivery lag p95</h3>
            {charts.lag[0]!.values.some((v) => v !== null) ? (
              <Chart times={charts.times} series={charts.lag} format={(v) => lag(v)} />
            ) : (
              <div className="empty">This sender signs no send time, so lag can't be measured.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Where the SDK README explains how deliveries are found (the repo is public). */
const INBOUND_DOCS =
  'https://github.com/theirside/theirside/blob/main/packages/sdk/README.md#inbound-webhooks';

/** Nothing monitored and nothing discovered: how deliveries are found, and what to try. */
function WebhooksEmpty() {
  return (
    <Card title="No webhooks yet" data-testid="webhooks-empty">
      <p>
        Deliveries from known senders (Stripe, GitHub, Shopify, Slack, Svix and others) are recorded
        automatically. Others show up here as discovered routes for you to confirm, or declare them
        in{' '}
        <code>
          init({'{'} webhooks: [{'{'} path, provider {'}'}] {'}'})
        </code>
        .{' '}
        <a href={INBOUND_DOCS} target="_blank" rel="noreferrer">
          How webhooks are found
        </a>
      </p>
      <p className="muted">
        Expected webhooks don&apos;t show? Start the receiving service with{' '}
        <code>THEIRSIDE_DEBUG=inbound</code> (or <code>debug: &apos;inbound&apos;</code> in{' '}
        <code>init()</code>): it logs why each incoming request was or wasn&apos;t picked up, and
        what each flush sent.
      </p>
    </Card>
  );
}

/**
 * The top of the Webhooks page: routes the SDK saw that look like deliveries from a
 * sender it can't identify, with Confirm (link to a provider or create one) and Ignore.
 * A confirmed route moves into the monitored list below.
 */
function DiscoveredSection({
  data,
  onChanged,
}: {
  data: WebhookCandidatesResponse;
  onChanged: () => void;
}) {
  const isAdmin = useIsAdmin();
  const [actionError, setActionError] = useState<string | undefined>();
  const pending = data.candidates.filter((c) => c.status === 'pending');
  if (pending.length === 0) return null;
  const done = (e?: string) => {
    setActionError(e);
    onChanged();
  };
  return (
    <Card
      title="Discovered, not monitored yet"
      data-testid="discovered-routes"
      actions={<span className="muted">never alerted on until confirmed</span>}
    >
      <p className="muted">
        Incoming requests that look like webhook deliveries from a sender the SDK can&apos;t
        identify. {isAdmin ? 'Confirm' : 'An admin confirms'} a route with its sender to monitor it;
        ignore routes that aren&apos;t webhooks, and the SDK stops reporting them.
      </p>
      <ErrorBox error={actionError} />
      <Table>
        <thead>
          <tr>
            <th>Route</th>
            <th>Service</th>
            <th>Suggested name</th>
            <th className="num">Deliveries/day</th>
            <th>First seen</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {pending.map((c) => (
            <CandidateRow key={c.endpoint} c={c} isAdmin={isAdmin} onDone={done} serviceColumn />
          ))}
        </tbody>
      </Table>
      {data.pending >= data.maxPending && (
        <p className="muted">
          Showing the first {data.maxPending} routes; new ones are recorded once some are confirmed
          or ignored.
        </p>
      )}
    </Card>
  );
}

/** #/webhooks: discovered routes first, then every provider's monitored webhooks. */
export function Webhooks({ environment }: { environment: string }) {
  const [range, setRange] = useState<Range>('24h');
  const [confirmed, setConfirmed] = useState(0);
  const [candidates, candidatesError, reloadCandidates] = usePoll(
    () => api<WebhookCandidatesResponse>('/v1/admin/webhooks/candidates'),
    [],
    60_000,
  );
  const pending = candidates?.candidates.some((c) => c.status === 'pending') ?? false;
  return (
    <>
      <div className="page-h">
        <h1>Webhooks</h1>
        <Segmented value={range} options={['1h', '24h', '7d']} onChange={setRange} />
      </div>
      <ErrorBox error={candidatesError} />
      {candidates && (
        <DiscoveredSection
          data={candidates}
          onChanged={() => {
            reloadCandidates();
            setConfirmed((n) => n + 1);
          }}
        />
      )}
      {candidates && (
        <WebhooksSection
          environment={environment}
          range={range}
          showProvider
          reloadKey={confirmed}
          empty={
            pending ? (
              <Empty>Nothing monitored yet: confirm a discovered route above.</Empty>
            ) : (
              <WebhooksEmpty />
            )
          }
        />
      )}
    </>
  );
}

function CandidateRow({
  c,
  isAdmin,
  onDone,
  serviceColumn = false,
}: {
  c: WebhookCandidate;
  isAdmin: boolean;
  onDone: (error?: string) => void;
  /** The service in a column of its own (Webhooks page) instead of under the route. */
  serviceColumn?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const act = (action: 'ignore' | 'restore', body: Record<string, string>) =>
    api(`/v1/admin/webhooks/candidates/${action}`, { method: 'PUT', body }).then(
      () => onDone(),
      (e: unknown) => onDone(String((e as Error).message)),
    );
  const columns = serviceColumn ? 7 : 6;
  return (
    <>
      <tr data-testid="candidate" data-endpoint={c.endpoint}>
        <td>
          <code>
            {c.method} {c.endpoint}
          </code>
          {!serviceColumn && c.lastService && <div className="muted">{c.lastService}</div>}
        </td>
        {serviceColumn && <td>{c.lastService ?? '–'}</td>}
        <td>
          {c.status === 'confirmed'
            ? c.provider
            : c.suggestedName
              ? titleCase(c.suggestedName)
              : '–'}
        </td>
        <td className="num">{num(c.deliveriesPerDay)}</td>
        <td>{ago(c.firstSeenAt)}</td>
        <td>{ago(c.lastSeenAt)}</td>
        <td>
          {c.status === 'pending' && (
            <div className="row">
              {isAdmin && (
                <Button
                  size="small"
                  variant="primary"
                  aria-expanded={confirming}
                  onClick={() => setConfirming(!confirming)}
                >
                  Confirm…
                </Button>
              )}
              <Button size="small" onClick={() => void act('ignore', { endpoint: c.endpoint })}>
                Ignore
              </Button>
            </div>
          )}
          {c.status !== 'pending' && (
            <div className="row">
              <Badge tone={c.status === 'confirmed' ? 'healthy' : 'neutral'}>{c.status}</Badge>
              {isAdmin && (
                <Button size="small" onClick={() => void act('restore', { endpoint: c.endpoint })}>
                  {c.status === 'confirmed' ? 'Stop monitoring' : 'Restore'}
                </Button>
              )}
            </div>
          )}
        </td>
      </tr>
      {confirming && c.status === 'pending' && (
        <tr className="detail">
          <td colSpan={columns}>
            <ConfirmRoute
              c={c}
              onCancel={() => setConfirming(false)}
              onDone={() => {
                setConfirming(false);
                onDone();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Settings → Providers: routes the SDK saw that look like webhook deliveries
 * from senders it can't identify. Nothing alerts on them until an admin
 * confirms one with a name; a member can ignore one, and the SDK stops
 * reporting it.
 */
export function DiscoveredWebhookRoutes() {
  const isAdmin = useIsAdmin();
  const [data, error, reload] = usePoll(
    () => api<WebhookCandidatesResponse>('/v1/admin/webhooks/candidates'),
    [],
    60_000,
  );
  const [actionError, setActionError] = useState<string | undefined>();
  if (!data || (data.candidates.length === 0 && !error)) return null;
  const pending = data.candidates.filter((c) => c.status === 'pending');
  const decided = data.candidates.filter((c) => c.status !== 'pending');
  const done = (e?: string) => {
    setActionError(e);
    reload();
  };
  const head = (
    <thead>
      <tr>
        <th>Route</th>
        <th>Suggested name</th>
        <th className="num">Deliveries/day</th>
        <th>First seen</th>
        <th>Last seen</th>
        <th />
      </tr>
    </thead>
  );
  return (
    <Card title="Discovered webhook routes" data-testid="discovered-webhooks">
      <p className="muted">
        Incoming POST/PUT requests that look like webhook deliveries from a sender the SDK
        can&apos;t identify. They never alert until {isAdmin ? 'you confirm' : 'an admin confirms'}{' '}
        the route with the sender&apos;s name; from then on it is monitored like any webhook. Ignore
        routes that aren&apos;t webhooks: the SDK stops reporting them.
      </p>
      <ErrorBox error={error ?? actionError} />
      {pending.length > 0 ? (
        <Table>
          {head}
          <tbody>
            {pending.map((c) => (
              <CandidateRow key={c.endpoint} c={c} isAdmin={isAdmin} onDone={done} />
            ))}
          </tbody>
        </Table>
      ) : (
        <Empty>No routes waiting for a decision.</Empty>
      )}
      {data.pending >= data.maxPending && (
        <p className="muted">
          Showing the first {data.maxPending} routes; new ones are recorded once some are confirmed
          or ignored.
        </p>
      )}
      {decided.length > 0 && (
        <details>
          <summary>Confirmed and ignored ({decided.length})</summary>
          <Table>
            {head}
            <tbody>
              {decided.map((c) => (
                <CandidateRow key={c.endpoint} c={c} isAdmin={isAdmin} onDone={done} />
              ))}
            </tbody>
          </Table>
        </details>
      )}
    </Card>
  );
}
