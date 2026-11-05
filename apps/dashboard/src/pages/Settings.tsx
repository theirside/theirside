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
} from '../api';
import { Card, CopyButton, Empty, ErrorBox, usePoll } from '../components/ui';
import { ago, when } from '../format';
import { href } from '../router';

const TABS = [
  ['providers', 'Providers'],
  ['alerts', 'Alert channels'],
  ['api-keys', 'API keys'],
  ['sdk', 'SDK health'],
  ['status-page', 'Status page'],
] as const;

export function Settings({ tab }: { tab: string }) {
  return (
    <>
      <div className="page-h">
        <h1>Settings</h1>
      </div>
      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <a key={id} href={href('settings', id)} className={tab === id ? 'on' : ''}>
            {label}
          </a>
        ))}
      </nav>
      {tab === 'providers' && <ProvidersTab />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'api-keys' && <ApiKeysTab />}
      {tab === 'sdk' && <SdkTab />}
      {tab === 'status-page' && <StatusPageTab />}
    </>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

const SOURCE_LABEL: Record<Provider['source'], string> = {
  configured: 'configured',
  discovered: 'discovered',
  catalog: 'known provider',
};

function ProviderForm({
  p,
  others,
  onSaved,
}: {
  p: Provider;
  others: Provider[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    displayName: p.displayName ?? '',
    hosts: p.hostPatterns.join('\n'),
    routes: p.explicitRoutes.join('\n'),
    supportEmail: p.supportEmail ?? '',
    supportUrl: p.supportUrl ?? '',
    supportNotes: p.supportNotes ?? '',
    publicDisplayName: p.publicDisplayName ?? '',
    isPublic: p.isPublic,
    alertsEnabled: p.alertsEnabled,
    pathPrivacy: p.pathPrivacy ?? '',
    allowedPathWords: p.allowedPathWords.join(' '),
  });
  const [state, setState] = useState<string>('');
  const [mergeInto, setMergeInto] = useState('');
  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm({
        ...form,
        [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value,
      });
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setState(`${label}…`);
    try {
      await fn();
      setState('saved');
      onSaved();
    } catch (e) {
      setState(String((e as Error).message));
    }
  };
  const patch = (body: Record<string, unknown>) =>
    api(`/v1/admin/providers/${p.id}`, { method: 'PATCH', body });
  const save = () =>
    run('saving', () =>
      patch({
        displayName: form.displayName.trim() || null,
        hostPatterns: lines(form.hosts),
        explicitRoutes: lines(form.routes),
        supportEmail: form.supportEmail || null,
        supportUrl: form.supportUrl || null,
        supportNotes: form.supportNotes || null,
        publicDisplayName: form.publicDisplayName || null,
        isPublic: form.isPublic,
        alertsEnabled: form.alertsEnabled,
        pathPrivacy: form.pathPrivacy || null,
        allowedPathWords: form.allowedPathWords
          .toLowerCase()
          .split(/[^a-z\d]+/)
          .filter(Boolean),
      }),
    );
  const label = p.displayName || p.name;
  return (
    <Card
      title={label}
      actions={
        <>
          <span className="muted">{state}</span>{' '}
          <span className="tag">{SOURCE_LABEL[p.source]}</span>
          {p.category && <span className="tag">{p.category}</span>}
          {p.hidden && <span className="tag red">hidden</span>}
          {p.internal && <span className="tag">internal</span>}
        </>
      }
    >
      {p.displayName && <p className="muted">Stored as {p.name}</p>}
      {p.hosts.length > 0 && (
        <div className="hosts">
          <span className="muted">Hosts seen:</span>
          {p.hosts.map((h) => (
            <span key={h} className="host">
              <code>{h}</code>
              {p.hosts.length + p.hostPatterns.length > 1 && (
                <button
                  className="btn small"
                  title="Track this host as a provider of its own (future traffic)"
                  onClick={() =>
                    void run('splitting', () =>
                      api(`/v1/admin/providers/${p.id}/split`, {
                        method: 'POST',
                        body: { host: h },
                      }),
                    )
                  }
                >
                  Split out
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="form">
        <label>
          Name in the dashboard <small>rename; data stays under {p.name}</small>
          <input value={form.displayName} onChange={set('displayName')} placeholder={p.name} />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.alertsEnabled} onChange={set('alertsEnabled')} />{' '}
          Alerts on <small>(incidents are tracked either way)</small>
        </label>
        <label>
          Host patterns{' '}
          <small>
            one per line (`api.x.com`, `*.x.io`); hosts matching them belong to this provider
          </small>
          <textarea rows={2} value={form.hosts} onChange={set('hosts')} />
        </label>
        <label>
          Explicit routes{' '}
          <small>`/v1/users/:userId`; sent to the SDK, override auto-templating</small>
          <textarea rows={2} value={form.routes} onChange={set('routes')} />
        </label>
        <label>
          Path privacy{' '}
          <small>
            strict: only known API words in paths, everything else is <code>:id</code>; balanced:
            any word seen often (only if paths never carry personal data)
          </small>
          <select value={form.pathPrivacy} onChange={set('pathPrivacy')}>
            <option value="">SDK setting (strict unless the app sets balanced)</option>
            <option value="strict">Strict</option>
            <option value="balanced">Balanced</option>
          </select>
        </label>
        <label>
          Allowed path words{' '}
          <small>
            sent as-is in strict mode, e.g. this provider&apos;s resource names (
            <code>sneakers</code>); never names or other personal data
          </small>
          <input
            value={form.allowedPathWords}
            onChange={set('allowedPathWords')}
            placeholder="sneakers jackets"
          />
        </label>
        <label>
          Support email
          <input
            value={form.supportEmail}
            onChange={set('supportEmail')}
            placeholder="support@provider.com"
          />
        </label>
        <label>
          Support URL
          <input value={form.supportUrl} onChange={set('supportUrl')} />
        </label>
        <label className="wide">
          Support notes
          <textarea rows={2} value={form.supportNotes} onChange={set('supportNotes')} />
        </label>
        <label>
          Public display name <small>shown on the status page instead of the provider name</small>
          <input
            value={form.publicDisplayName}
            onChange={set('publicDisplayName')}
            placeholder="Card issuing"
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.isPublic} onChange={set('isPublic')} /> Show on the
          public status page
        </label>
        <div>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
      <div className="provider-actions">
        <button
          className="btn"
          title="Stop collecting this provider (the SDK drops it within a minute)"
          onClick={() => void run('saving', () => patch({ hidden: !p.hidden }))}
        >
          {p.hidden ? 'Unhide' : 'Hide'}
        </button>
        <button
          className="btn"
          title="Your own service: never collected"
          onClick={() => void run('saving', () => patch({ internal: !p.internal }))}
        >
          {p.internal ? 'Not internal' : 'Mark internal'}
        </button>
        {others.length > 0 && (
          <span className="merge">
            <select
              value={mergeInto}
              onChange={(e) => setMergeInto(e.target.value)}
              aria-label="Merge into"
            >
              <option value="">Merge into…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName || o.name}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!mergeInto}
              onClick={() => {
                const target = others.find((o) => o.id === mergeInto);
                if (
                  !target ||
                  !confirm(
                    `Merge ${label} into ${target.displayName || target.name}? Its history moves too.`,
                  )
                )
                  return;
                void run('merging', () =>
                  api(`/v1/admin/providers/${p.id}/merge`, {
                    method: 'POST',
                    body: { into: target.id },
                  }),
                );
              }}
            >
              Merge
            </button>
          </span>
        )}
      </div>
    </Card>
  );
}

function DiscoverySettings() {
  const [data, , reload] = usePoll(
    () => api<{ digest: boolean }>('/v1/admin/settings/discovery'),
    [],
    60_000,
  );
  if (!data) return null;
  return (
    <label className="check discovery-setting">
      <input
        type="checkbox"
        checked={data.digest}
        onChange={(e) =>
          void api('/v1/admin/settings/discovery', {
            method: 'PUT',
            body: { digest: e.target.checked },
          }).then(reload)
        }
      />{' '}
      Send a message to alert channels when new providers are discovered (at most hourly)
    </label>
  );
}

function ProvidersTab() {
  const [data, error, reload] = usePoll(
    () => api<{ providers: Provider[] }>('/v1/admin/providers'),
    [],
    60_000,
  );
  const providers = data?.providers ?? [];
  // newest first, so freshly discovered providers are easy to review
  const sorted = [...providers].sort(
    (a, b) =>
      Number(a.hidden || a.internal) - Number(b.hidden || b.internal) ||
      Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt),
  );
  return (
    <>
      <ErrorBox error={error} />
      <p className="muted">
        The SDK finds providers on its own; review new ones, rename or merge them, and hide anything
        internal. Changes reach the SDK within a minute.
      </p>
      <DiscoverySettings />
      {data?.providers.length === 0 && (
        <Empty>Providers appear here as soon as the SDK reports calls to them.</Empty>
      )}
      {sorted.map((p) => (
        <ProviderForm
          key={`${p.id}:${p.hidden}:${p.internal}:${p.hosts.length}`}
          p={p}
          others={providers.filter((o) => o.id !== p.id && !o.hidden && !o.internal)}
          onSaved={reload}
        />
      ))}
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
        <table className="table">
          <tbody>
            {channels?.map((c) => (
              <tr key={c.id}>
                <td>
                  <b>{c.name}</b> <span className="tag">{c.kind}</span>{' '}
                  {!c.enabled && <span className="tag">disabled</span>}
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
                  <button className="btn" onClick={() => void test(c)}>
                    Send test alert
                  </button>
                  <button className="btn" onClick={() => void toggle(c)}>
                    {c.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn danger" onClick={() => void remove(c)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Add channel" actions={<span className="muted">{msg.add}</span>}>
        <div className="form">
          <label>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as AlertChannel['kind'])}>
              <option value="slack">Slack (incoming webhook)</option>
              <option value="webhook">Webhook (HMAC signed)</option>
              <option value="email">Email (SMTP)</option>
            </select>
          </label>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="#integrations-alerts"
            />
          </label>
          <label className="wide">
            {kind === 'slack'
              ? 'Webhook URL'
              : kind === 'webhook'
                ? 'URL'
                : 'Recipients (comma-separated)'}
            <input value={target} onChange={(e) => setTarget(e.target.value)} />
          </label>
          {kind === 'webhook' && (
            <label className="wide">
              Signing secret <small>min. 16 characters; requests carry x-theirside-signature</small>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
          )}
          <div>
            <button className="btn primary" onClick={() => void add()}>
              Add
            </button>
          </div>
        </div>
      </Card>
      <Card title="Recent deliveries">
        <table className="table">
          <tbody>
            {deliveries?.map((d) => (
              <tr key={d.id}>
                <td>
                  <span className={`tag ${d.status === 'failed' ? 'red' : ''}`}>{d.status}</span>{' '}
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
        </table>
        {deliveries?.length === 0 && <div className="empty">Nothing sent yet.</div>}
      </Card>
    </>
  );
}

function SdkTab() {
  const [data, error] = usePoll(
    () => api<{ instances: SdkInstance[] }>('/v1/admin/sdk-instances'),
    [],
  );
  return (
    <>
      <ErrorBox error={error} />
      {data?.instances.length === 0 && <Empty>No SDK has reported yet.</Empty>}
      {data && data.instances.length > 0 && (
        <table className="table" data-testid="sdk">
          <thead>
            <tr>
              <th>Service</th>
              <th>Environment</th>
              <th>SDK</th>
              <th>Last seen</th>
              <th className="num">Dropped events</th>
              <th>Last flush error</th>
            </tr>
          </thead>
          <tbody>
            {data.instances.map((s) => (
              <tr key={s.service + s.environment} className={s.stale ? 'amber' : ''}>
                <td>{s.service}</td>
                <td>{s.environment}</td>
                <td>
                  {s.sdkName} {s.sdkVersion}
                </td>
                <td title={when(s.lastSeenAt)}>
                  {ago(s.lastSeenAt)} {s.stale && <span className="tag">stale</span>}
                </td>
                <td className="num">{s.droppedEvents.toLocaleString()}</td>
                <td className="muted">{s.lastFlushError ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
        one. Services need the <b>ingest</b> scope; <b>read</b> is for the health API.
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
          <button className="btn" onClick={() => setCreated(null)}>
            Done
          </button>
        </Card>
      )}
      <Card title="Keys">
        {data && active.length === 0 && <div className="empty">No active keys.</div>}
        <table className="table" data-testid="api-keys">
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
                <td className="mono">{k.keyPrefix}…</td>
                <td>
                  {k.scopes.map((s) => (
                    <span key={s} className="tag">
                      {s}
                    </span>
                  ))}
                </td>
                <td className="muted">{when(k.createdAt)}</td>
                <td className="muted">{k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
                <td className="actions">
                  <button className="btn danger" onClick={() => void revoke(k)}>
                    Revoke
                  </button>
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
                  <span className="tag">revoked {ago(k.revokedAt!)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Create key" actions={<span className="error">{msg}</span>}>
        <div className="form">
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="payments-api production"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={scopes.ingest}
              onChange={(e) => setScopes({ ...scopes, ingest: e.target.checked })}
            />
            ingest (SDK)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={scopes.read}
              onChange={(e) => setScopes({ ...scopes, read: e.target.checked })}
            />
            read (health API)
          </label>
          <div>
            <button
              className="btn primary"
              disabled={!name.trim() || (!scopes.ingest && !scopes.read)}
              onClick={() => void create()}
            >
              Create key
            </button>
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
      <label>
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Integration status"
        />
      </label>
      <label>
        Theme
        <select value={theme} onChange={(e) => setTheme(e.target.value as StatusPage['theme'])}>
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <div className="wide">
        <div className="muted">
          Providers shown (none ticked = every public provider). Only providers marked public in
          Settings → Providers can appear.
        </div>
        {publicProviders.length === 0 && <div className="muted">No public providers yet.</div>}
        {publicProviders.map((p) => (
          <label key={p.id} className="check">
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
          </label>
        ))}
      </div>
      <div>
        <button className="btn primary" disabled={!title.trim()} onClick={() => void submit()}>
          {submitLabel}
        </button>{' '}
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}{' '}
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
              <button className="btn" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                Edit
              </button>{' '}
              <button className="btn danger" onClick={() => void remove(p)}>
                Delete
              </button>
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
                <span className="tag">{p.theme}</span>{' '}
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
        <div className="notice" data-testid="status-page-limit">
          {data.limitMessage}
        </div>
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
          <button className="btn primary" onClick={() => setAdding(true)}>
            New status page
          </button>
        ))}
    </>
  );
}
