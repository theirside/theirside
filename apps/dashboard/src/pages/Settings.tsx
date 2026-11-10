import { useState } from 'react';
import {
  api,
  type ApiKey,
  type AlertChannel,
  type Delivery,
  type Provider,
  type SdkInstance,
  type StatusPage,
  type StatusPageList,
  type Me,
} from '../api';
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  Empty,
  ErrorBox,
  Field,
  Table,
  Tabs,
  usePoll,
} from '../components/ui';
import { ago, when } from '../format';
import { href } from '../router';
import { useIsAdmin } from '../role';
import { ProviderPanel, ProvidersTable } from './ProviderSettings';
import { ThresholdsTab } from './Thresholds';
import { UsersTab } from './Users';

/** [id, label, admins only] */
const TABS = [
  ['providers', 'Providers', false],
  ['thresholds', 'Thresholds', false],
  ['alerts', 'Alert channels', true],
  ['api-keys', 'API keys', true],
  ['sdk', 'SDK health', false],
  ['status-page', 'Status page', true],
  ['users', 'Users', true],
] as const;

export function Settings({ tab, sub, me }: { tab: string; sub?: string; me: Me }) {
  const isAdmin = useIsAdmin();
  const tabs = TABS.filter(([, , adminOnly]) => isAdmin || !adminOnly);
  if (!tabs.some(([id]) => id === tab))
    return (
      <>
        <div className="page-h">
          <h1>Settings</h1>
        </div>
        <Callout>
          Only admins can manage alert channels, API keys, status pages and users. Ask an admin if
          you need a change, or to make you an admin.{' '}
          <a href={href('settings', 'providers')}>Back to providers</a>
        </Callout>
      </>
    );
  return (
    <>
      <div className="page-h">
        <h1>Settings</h1>
      </div>
      <Tabs
        label="Settings"
        value={tab}
        items={tabs.map(([id, label]) => ({ id, label, href: href('settings', id) }))}
      />
      {tab === 'providers' && <ProvidersTab name={sub} />}
      {tab === 'thresholds' && <ThresholdsTab />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'api-keys' && <ApiKeysTab />}
      {tab === 'sdk' && <SdkTab />}
      {tab === 'status-page' && <StatusPageTab />}
      {tab === 'users' && <UsersTab me={me} />}
    </>
  );
}

function DiscoverySettings() {
  const isAdmin = useIsAdmin();
  const [data, , reload] = usePoll(
    () => api<{ digest: boolean }>('/v1/admin/settings/discovery'),
    [],
    60_000,
  );
  if (!data) return null;
  return (
    <Field check className="discovery-setting">
      <input
        type="checkbox"
        checked={data.digest}
        disabled={!isAdmin}
        onChange={(e) =>
          void api('/v1/admin/settings/discovery', {
            method: 'PUT',
            body: { digest: e.target.checked },
          }).then(reload)
        }
      />{' '}
      Send a message to alert channels when new providers are discovered (at most hourly)
      {!isAdmin && <small className="muted"> (admins only)</small>}
    </Field>
  );
}

function ProvidersTab({ name }: { name: string | undefined }) {
  if (name) return <ProviderPanel name={name} />;
  return (
    <>
      <p className="muted">
        The SDK finds providers on its own; review new ones, rename or merge them, and hide anything
        internal. Click a provider for its settings. Changes reach the SDK within a minute.
      </p>
      <DiscoverySettings />
      <ProvidersTable />
    </>
  );
}

const EMPTY_CONFIG: Record<AlertChannel['kind'], Record<string, unknown>> = {
  slack: { webhookUrl: '' },
  webhook: { url: '', secret: '' },
  email: { to: [] },
};

function AlertsTab() {
  const [channels, error, reload] = usePoll(
    () => api<AlertChannel[]>('/v1/admin/alert-channels'),
    [],
    30_000,
  );
  const [deliveries, , reloadDeliveries] = usePoll(
    () => api<Delivery[]>('/v1/admin/deliveries'),
    [],
    15_000,
  );
  const [kind, setKind] = useState<AlertChannel['kind']>('slack');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<Record<string, string>>({});
  const add = async () => {
    const config =
      kind === 'slack'
        ? { webhookUrl: target }
        : kind === 'webhook'
          ? { url: target, secret }
          : {
              to: target
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            };
    try {
      await api('/v1/admin/alert-channels', {
        method: 'POST',
        body: { kind, name: name || kind, config: { ...EMPTY_CONFIG[kind], ...config } },
      });
      setName('');
      setTarget('');
      setSecret('');
      setMsg({ ...msg, add: 'added' });
      reload();
    } catch (e) {
      setMsg({ ...msg, add: String((e as Error).message) });
    }
  };
  const [testResult, setTestResult] = useState<
    Record<string, { state: 'sending' | 'sent' | 'failed'; text: string }>
  >({});
  const test = async (c: AlertChannel) => {
    setTestResult((r) => ({ ...r, [c.id]: { state: 'sending', text: 'Sending…' } }));
    const r = await api<{ status: string; error: string | null }>(
      `/v1/admin/alert-channels/${c.id}/test`,
      { method: 'POST' },
    ).catch((e) => ({ status: 'failed', error: String((e as Error).message) }));
    const where =
      c.kind === 'email' ? 'the inbox' : c.kind === 'slack' ? 'the Slack channel' : 'the receiver';
    setTestResult((prev) => ({
      ...prev,
      [c.id]:
        r.status === 'sent'
          ? { state: 'sent', text: `Sent. Check ${where}.` }
          : { state: 'failed', text: `Failed: ${r.error ?? 'unknown error'}` },
    }));
    reloadDeliveries();
  };
  const toggle = async (c: AlertChannel) => {
    await api(`/v1/admin/alert-channels/${c.id}`, {
      method: 'PATCH',
      body: { enabled: !c.enabled },
    });
    reload();
  };
  const remove = async (c: AlertChannel) => {
    if (!confirm(`Delete ${c.name}?`)) return;
    await api(`/v1/admin/alert-channels/${c.id}`, { method: 'DELETE' });
    reload();
  };
  return (
    <>
      <ErrorBox error={error} />
      <Card title="Channels">
        {channels?.length === 0 && (
          <div className="empty">No channels yet. Alerts are only stored until you add one.</div>
        )}
        <Table>
          <tbody>
            {channels?.map((c) => (
              <tr key={c.id}>
                <td>
                  <b>{c.name}</b> <Badge>{c.kind}</Badge> {!c.enabled && <Badge>disabled</Badge>}
                </td>
                <td className="muted">
                  {String(
                    c.config.webhookUrl ??
                      c.config.url ??
                      (c.config.to as string[] | undefined)?.join(', ') ??
                      '',
                  )}
                </td>
                <td className="actions">
                  {testResult[c.id] && (
                    <span
                      className={`test-result ${testResult[c.id]!.state}`}
                      role="status"
                      data-testid={`test-result-${c.id}`}
                    >
                      {testResult[c.id]!.text}
                    </span>
                  )}
                  <Button onClick={() => void test(c)}>Send test alert</Button>
                  <Button className="toggle" onClick={() => void toggle(c)}>
                    {c.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="danger" onClick={() => void remove(c)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title="Add channel" actions={<span className="muted">{msg.add}</span>}>
        <div className="form">
          <Field>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as AlertChannel['kind'])}>
              <option value="slack">Slack (incoming webhook)</option>
              <option value="webhook">Webhook (HMAC signed)</option>
              <option value="email">Email (SMTP)</option>
            </select>
          </Field>
          <Field>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="#integrations-alerts"
            />
          </Field>
          <Field wide>
            {kind === 'slack'
              ? 'Webhook URL'
              : kind === 'webhook'
                ? 'URL'
                : 'Recipients (comma-separated)'}
            <input value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          {kind === 'webhook' && (
            <Field wide>
              Signing secret <small>min. 16 characters; requests carry x-theirside-signature</small>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} />
            </Field>
          )}
          <div>
            <Button variant="primary" onClick={() => void add()}>
              Add
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Recent deliveries">
        <Table>
          <tbody>
            {deliveries?.map((d) => (
              <tr key={d.id}>
                <td>
                  <Badge tone={d.status === 'failed' ? 'danger' : undefined}>{d.status}</Badge>{' '}
                  {d.event}
                </td>
                <td>
                  {d.incidentId ? <a href={href('incidents', d.incidentId)}>{d.title}</a> : d.title}
                </td>
                <td className="muted">
                  {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                  {d.lastError ? ` · ${d.lastError}` : ''}
                </td>
                <td className="muted">{ago(d.sentAt ?? d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {deliveries?.length === 0 && <div className="empty">Nothing sent yet.</div>}
      </Card>
    </>
  );
}

const SDK_STATUS: Record<SdkInstance['status'], [string, string]> = {
  running: ['running', ''],
  idle: ['running, idle', 'no calls lately; the SDK still checks in'],
  not_running: ['not running', 'no batch and no heartbeat for 15 minutes'],
  ok: ['ok', ''],
  silent: ['silent', 'it sent regularly and has been quiet far longer than usual'],
  stale: [
    'stale',
    'no batch for 10 minutes (SDKs before 0.2.0 send no heartbeat, so idle looks the same)',
  ],
};

const gapText = (s: number | null) =>
  s === null
    ? ''
    : s < 120
      ? `every ~${s}s`
      : s < 7200
        ? `every ~${Math.round(s / 60)} min`
        : `every ~${Math.round(s / 3600)} h`;

function SdkTab() {
  const [data, error] = usePoll(
    () => api<{ instances: SdkInstance[] }>('/v1/admin/sdk-instances'),
    [],
  );
  return (
    <>
      <ErrorBox error={error} />
      <p className="muted">
        One row per service and environment. Functions and other short-lived processes are never
        flagged for being quiet between invocations, only when a regular one stops for much longer
        than usual.
      </p>
      {data?.instances.length === 0 && <Empty>No SDK has reported yet.</Empty>}
      {data && data.instances.length > 0 && (
        <Table data-testid="sdk">
          <thead>
            <tr>
              <th>Service</th>
              <th>Environment</th>
              <th>Runs as</th>
              <th className="num">Processes</th>
              <th>Last call</th>
              <th>Status</th>
              <th>SDK</th>
              <th className="num">Dropped events</th>
              <th>Last flush error</th>
            </tr>
          </thead>
          <tbody>
            {data.instances.map((s) => {
              const [label, hint] = SDK_STATUS[s.status];
              return (
                <tr key={s.service + s.environment} className={s.stale ? 'amber' : ''}>
                  <td>{s.service}</td>
                  <td>{s.environment}</td>
                  <td>
                    {s.kind === 'short-lived'
                      ? 'short-lived'
                      : s.kind === 'long-running'
                        ? 'long-running'
                        : '–'}
                    {s.platform && (
                      <>
                        <br />
                        <Badge>{s.platform}</Badge>
                      </>
                    )}
                  </td>
                  <td className="num" title="active now / seen in the last 24 hours">
                    {s.kind === 'legacy' ? '–' : `${s.processes.active} / ${s.processes.lastDay}`}
                  </td>
                  <td title={s.lastEventAt ? when(s.lastEventAt) : undefined}>
                    {s.lastEventAt ? ago(s.lastEventAt) : '–'}{' '}
                    {s.kind === 'short-lived' && (
                      <span className="muted">{gapText(s.usualGapSeconds)}</span>
                    )}
                  </td>
                  <td title={hint || undefined}>
                    {s.stale ? <Badge tone="danger">{label}</Badge> : label}
                  </td>
                  <td>
                    {s.sdkVersions.length > 1
                      ? s.sdkVersions.join(', ')
                      : `${s.sdkName} ${s.sdkVersion}`}
                  </td>
                  <td className="num">{s.droppedEvents.toLocaleString()}</td>
                  <td className="muted">{s.lastFlushError ?? '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}

function ApiKeysTab() {
  const [data, error, reload] = usePoll(
    () => api<{ apiKeys: ApiKey[] }>('/v1/admin/api-keys'),
    [],
    60_000,
  );
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState({ ingest: true, read: false });
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [msg, setMsg] = useState('');
  const create = async () => {
    setMsg('');
    try {
      const r = await api<ApiKey & { key: string }>('/v1/admin/api-keys', {
        method: 'POST',
        body: {
          name: name.trim(),
          scopes: (['ingest', 'read'] as const).filter((s) => scopes[s]),
        },
      });
      setCreated({ name: r.name, key: r.key });
      setName('');
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke "${k.name}" (${k.keyPrefix}…)? Services using it stop reporting at once.`))
      return;
    try {
      await api(`/v1/admin/api-keys/${k.id}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const active = data?.apiKeys.filter((k) => !k.revokedAt) ?? [];
  const revoked = data?.apiKeys.filter((k) => k.revokedAt) ?? [];
  return (
    <>
      <ErrorBox error={error} />
      <p className="muted">
        One key per service makes rotation easy: create a new key, deploy it, then revoke the old
        one. Services need the <b>ingest</b> scope; <b>read</b> is for the health API.{' '}
        <a href={href('connect')}>How to connect an app</a>
      </p>
      {created && (
        <Card
          title={`New key: ${created.name}`}
          actions={<CopyButton text={created.key} label="Copy key" />}
        >
          <p>Copy it now. It is shown only once and cannot be recovered; only a hash is stored.</p>
          <pre className="summary" data-testid="new-api-key">
            {created.key}
          </pre>
          <Button onClick={() => setCreated(null)}>Done</Button>
        </Card>
      )}
      <Card title="Keys">
        {data && active.length === 0 && <div className="empty">No active keys.</div>}
        <Table data-testid="api-keys">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Scopes</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {active.map((k) => (
              <tr key={k.id}>
                <td>
                  <b>{k.name}</b>
                </td>
                <td>
                  {k.key ? (
                    <span className="row" data-testid="visible-api-key">
                      <span className="mono">{k.key}</span>
                      <CopyButton text={k.key} label="Copy key" />
                    </span>
                  ) : (
                    <span className="mono">{k.keyPrefix}…</span>
                  )}
                </td>
                <td>
                  {k.scopes.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </td>
                <td className="muted">{when(k.createdAt)}</td>
                <td className="muted">{k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
                <td className="actions">
                  <Button variant="danger" onClick={() => void revoke(k)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
            {revoked.map((k) => (
              <tr key={k.id} className="muted">
                <td>{k.name}</td>
                <td className="mono">{k.keyPrefix}…</td>
                <td>{k.scopes.join(', ')}</td>
                <td>{when(k.createdAt)}</td>
                <td>{k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
                <td>
                  <Badge>revoked {ago(k.revokedAt!)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title="Create key" actions={<span className="error">{msg}</span>}>
        <div className="form">
          <Field>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="payments-api production"
            />
          </Field>
          <fieldset className="field wide checks">
            <legend>Scopes</legend>
            <Field check>
              <input
                type="checkbox"
                checked={scopes.ingest}
                onChange={(e) => setScopes({ ...scopes, ingest: e.target.checked })}
              />
              ingest (SDK)
            </Field>
            <Field check>
              <input
                type="checkbox"
                checked={scopes.read}
                onChange={(e) => setScopes({ ...scopes, read: e.target.checked })}
              />
              read (health API)
            </Field>
          </fieldset>
          <div className="form-actions">
            <Button
              variant="primary"
              disabled={!name.trim() || (!scopes.ingest && !scopes.read)}
              onClick={() => void create()}
            >
              Create key
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

const THEMES = ['auto', 'light', 'dark'] as const;

function StatusPageForm({
  initial,
  providers,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { title: string; theme: StatusPage['theme']; providerFilter: string[] };
  providers: Provider[];
  submitLabel: string;
  onSubmit: (v: {
    title: string;
    theme: StatusPage['theme'];
    providerFilter: string[];
  }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [theme, setTheme] = useState(initial.theme);
  const [filter, setFilter] = useState<string[]>(initial.providerFilter);
  const [msg, setMsg] = useState('');
  const publicProviders = providers.filter((p) => p.isPublic);
  const submit = async () => {
    setMsg('');
    try {
      await onSubmit({ title: title.trim(), theme, providerFilter: filter });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="form">
      <Field>
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Integration status"
        />
      </Field>
      <Field>
        Theme
        <select value={theme} onChange={(e) => setTheme(e.target.value as StatusPage['theme'])}>
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <div className="wide">
        <div className="muted">
          Providers shown (none ticked = every public provider). Only providers marked public in
          Settings → Providers can appear.
        </div>
        {publicProviders.length === 0 && <div className="muted">No public providers yet.</div>}
        {publicProviders.map((p) => (
          <Field key={p.id} check>
            <input
              type="checkbox"
              checked={filter.includes(p.name)}
              onChange={(e) =>
                setFilter(
                  e.target.checked ? [...filter, p.name] : filter.filter((n) => n !== p.name),
                )
              }
            />
            {p.publicDisplayName || p.name}
          </Field>
        ))}
      </div>
      <div>
        <Button variant="primary" disabled={!title.trim()} onClick={() => void submit()}>
          {submitLabel}
        </Button>{' '}
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}{' '}
        <span className="error">{msg}</span>
      </div>
    </div>
  );
}

function StatusPageTab() {
  const [data, error, reload] = usePoll(
    () => api<StatusPageList>('/v1/admin/status-pages'),
    [],
    60_000,
  );
  const [providers] = usePoll(
    () => api<{ providers: Provider[] }>('/v1/admin/providers').then((r) => r.providers),
    [],
    60_000,
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const remove = async (p: StatusPage) => {
    if (!confirm(`Delete "${p.title}"? Sites embedding it will show "not found".`)) return;
    await api(`/v1/admin/status-pages/${p.id}`, { method: 'DELETE' });
    reload();
  };
  return (
    <>
      <ErrorBox error={error} />
      <p className="muted">
        Only providers marked “Show on the public status page” appear, under their public display
        name, with status and a 30-day bar. No endpoint paths or call volumes are shown. Edits show
        on the public page within 30 s.
      </p>
      {data?.statusPages.map((p) => (
        <Card
          key={p.id}
          title={p.title}
          actions={
            <>
              <Button onClick={() => setEditing(editing === p.id ? null : p.id)}>Edit</Button>{' '}
              <Button variant="danger" onClick={() => void remove(p)}>
                Delete
              </Button>
            </>
          }
        >
          {editing === p.id ? (
            <StatusPageForm
              initial={p}
              providers={providers ?? []}
              submitLabel="Save"
              onCancel={() => setEditing(null)}
              onSubmit={async (v) => {
                await api(`/v1/admin/status-pages/${p.id}`, { method: 'PATCH', body: v });
                setEditing(null);
                reload();
              }}
            />
          ) : (
            <>
              <p>
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.url}
                </a>{' '}
                <Badge>{p.theme}</Badge>{' '}
                <span className="muted">
                  {p.providerFilter.length ? p.providerFilter.join(', ') : 'all public providers'}
                </span>
              </p>
              <p className="muted">Embed it in your site:</p>
              <pre className="summary">{p.embedSnippet}</pre>
              <CopyButton text={p.embedSnippet} label="Copy snippet" />
            </>
          )}
        </Card>
      ))}
      {data && !data.canCreate && (
        <Callout data-testid="status-page-limit">{data.limitMessage}</Callout>
      )}
      {data?.canCreate &&
        (adding ? (
          <Card title="New status page">
            <StatusPageForm
              initial={{ title: '', theme: 'auto', providerFilter: [] }}
              providers={providers ?? []}
              submitLabel="Create"
              onCancel={() => setAdding(false)}
              onSubmit={async (v) => {
                await api('/v1/admin/status-pages', { method: 'POST', body: v });
                setAdding(false);
                reload();
              }}
            />
          </Card>
        ) : (
          <Button variant="primary" onClick={() => setAdding(true)}>
            New status page
          </Button>
        ))}
    </>
  );
}
