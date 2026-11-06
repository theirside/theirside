import { useMemo, useState, type ReactNode } from 'react';
import { ALLOWED_WORD, normalizePathWord } from '@theirside/shared/core';
import { api, type Provider } from '../api';
import { Card, Empty, ErrorBox, usePoll } from '../components/ui';
import { ago } from '../format';
import { href } from '../router';
import { useIsAdmin } from '../role';

/**
 * Settings → Providers: a compact, searchable, sortable table (tabs: all, new,
 * alerts off and infrastructure, hidden and internal), and one settings page
 * per provider (`#/settings/providers/<name>`), also opened by "manage" on the
 * provider page. The collector enforces the same role rules the page shows.
 */

const WEEK = 7 * 24 * 3600_000;

const SOURCE_LABEL: Record<Provider['source'], string> = {
  configured: 'configured',
  discovered: 'discovered',
  catalog: 'known provider',
};

const TABS = [
  ['all', 'All', (_p: Provider) => true],
  [
    'new',
    'New (7 days)',
    (p: Provider) => p.source !== 'configured' && Date.now() - Date.parse(p.firstSeenAt) < WEEK,
  ],
  [
    'quiet',
    'Alerts off & infrastructure',
    (p: Provider) => !p.alertsEnabled || p.category === 'infrastructure',
  ],
  ['hidden', 'Hidden & internal', (p: Provider) => p.hidden || p.internal],
] as const;
type TabId = (typeof TABS)[number][0];

type SortKey = 'name' | 'category' | 'hosts' | 'alerts' | 'thresholds' | 'lastCall';
const COLUMNS: [SortKey, string, boolean][] = [
  ['name', 'Provider', false],
  ['category', 'Category', false],
  ['hosts', 'Hosts', true],
  ['alerts', 'Alerts', false],
  ['thresholds', 'Thresholds', false],
  ['lastCall', 'Last call', true],
];

const labelOf = (p: Provider) => p.displayName || p.name;
const hostCount = (p: Provider) => p.hosts.length + p.hostPatterns.length;
const overrides = (p: Provider) => Object.keys(p.thresholds ?? {}).length;

function sortValue(p: Provider, k: SortKey): string | number {
  switch (k) {
    case 'name':
      return labelOf(p).toLowerCase();
    case 'category':
      return p.category ?? '';
    case 'hosts':
      return hostCount(p);
    case 'alerts':
      return Number(p.alertsEnabled);
    case 'thresholds':
      return overrides(p);
    case 'lastCall':
      return p.lastCallAt ? Date.parse(p.lastCallAt) : 0;
  }
}

export function ProvidersTable() {
  const [data, error] = usePoll(
    () => api<{ providers: Provider[] }>('/v1/admin/providers'),
    [],
    60_000,
  );
  const [tab, setTab] = useState<TabId>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'lastCall',
    desc: true,
  });
  const providers = data?.providers ?? [];
  const query = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const filter = TABS.find(([id]) => id === tab)![2];
    const rows = providers.filter(
      (p) =>
        filter(p) &&
        (!query ||
          [p.name, p.displayName ?? '', p.category ?? '', ...p.hosts, ...p.hostPatterns].some((s) =>
            s.toLowerCase().includes(query),
          )),
    );
    const dir = sort.desc ? -1 : 1;
    return rows.sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || labelOf(a).localeCompare(labelOf(b));
    });
  }, [providers, tab, query, sort]);
  const by = (key: SortKey, numeric: boolean) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: numeric }));

  return (
    <>
      <ErrorBox error={error} />
      <div className="table-tools">
        <nav className="tabs subtabs" role="tablist">
          {TABS.map(([id, label, filter]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'on' : ''}
              onClick={() => setTab(id)}
            >
              {label} <span className="muted">{providers.filter(filter).length}</span>
            </button>
          ))}
        </nav>
        <input
          type="search"
          placeholder="Search name, host, category"
          aria-label="Search providers"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {data && providers.length === 0 && (
        <Empty>Providers appear here as soon as the SDK reports calls to them.</Empty>
      )}
      {providers.length > 0 && (
        <table className="table providers-table" data-testid="provider-settings">
          <thead>
            <tr>
              {COLUMNS.map(([key, label, numeric]) => (
                <th
                  key={key}
                  className={numeric ? 'num' : ''}
                  aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                >
                  <button className="sort" onClick={() => by(key, numeric)}>
                    {label}
                    {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr
                key={p.id}
                className="clickable"
                onClick={() => (window.location.hash = href('settings', 'providers', p.name))}
              >
                <td>
                  <a href={href('settings', 'providers', p.name)} className="provider-link">
                    {labelOf(p)}
                  </a>
                  {p.displayName && <span className="muted"> {p.name}</span>}
                  {p.hidden && <span className="tag red">hidden</span>}
                  {p.internal && <span className="tag">internal</span>}
                </td>
                <td>{p.category ?? '–'}</td>
                <td className="num">{hostCount(p)}</td>
                <td>{p.alertsEnabled ? 'on' : <span className="muted">off</span>}</td>
                <td>
                  {overrides(p) > 0 ? (
                    <span className="tag">
                      {overrides(p)} override{overrides(p) > 1 ? 's' : ''}
                    </span>
                  ) : (
                    <span className="muted">default</span>
                  )}
                </td>
                <td className="num">{p.lastCallAt ? ago(p.lastCallAt) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {providers.length > 0 && shown.length === 0 && (
        <div className="empty">No providers match.</div>
      )}
    </>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/** Thresholds a provider may override: [key, label, unit, to UI, from UI]. */
const THRESHOLDS: [string, string, string, (v: number) => number, (v: number) => number][] = [
  ['minCalls', 'Minimum calls in the window', 'calls', (v) => v, (v) => v],
  ['openAfterMinutes', 'Bad minutes in a row to open', 'min', (v) => v, (v) => v],
  ['rateMultiplier', 'Error rate: multiple of normal', '×', (v) => v, (v) => v],
  [
    'rateDeltaPp',
    'Error rate: margin above normal',
    'pp',
    (v) => Math.round(v * 10_000) / 100,
    (v) => v / 100,
  ],
  ['latencyMultiplier', 'Latency: p95 multiple of normal', '×', (v) => v, (v) => v],
  ['latencyDeltaMs', 'Latency: p95 margin above normal', 'ms', (v) => v, (v) => v],
];

function Section({
  title,
  admin,
  children,
}: {
  title: string;
  /** What only admins may change here, shown to members. */
  admin?: string;
  children: ReactNode;
}) {
  const isAdmin = useIsAdmin();
  return (
    <Card title={title} actions={admin && !isAdmin ? <span className="muted">{admin}</span> : null}>
      {children}
    </Card>
  );
}

export function ProviderPanel({ name }: { name: string }) {
  const [data, error, reload] = usePoll(
    () => api<{ providers: Provider[] }>('/v1/admin/providers'),
    [],
    60_000,
  );
  const [project] = usePoll(
    () => api<{ effective: Record<string, number> }>('/v1/admin/settings/thresholds'),
    [],
    300_000,
  );
  const p = data?.providers.find((x) => x.name === name);
  return (
    <>
      <div className="page-h">
        <h2>
          <a href={href('settings', 'providers')} className="muted">
            Providers
          </a>{' '}
          / {p ? labelOf(p) : name}
        </h2>
        {p && (
          <a href={href('providers', p.name)} className="tag" title="Health and charts">
            open dashboard
          </a>
        )}
      </div>
      <ErrorBox error={error} />
      {data && !p && <div className="empty">No provider named {name}.</div>}
      {p && (
        <ProviderForm
          key={p.id}
          p={p}
          others={data!.providers.filter((o) => o.id !== p.id && !o.hidden && !o.internal)}
          project={project?.effective ?? {}}
          onSaved={reload}
        />
      )}
    </>
  );
}

function ProviderForm({
  p,
  others,
  project,
  onSaved,
}: {
  p: Provider;
  others: Provider[];
  project: Record<string, number>;
  onSaved: () => void;
}) {
  const isAdmin = useIsAdmin();
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
  // overrides as typed (UI units); '' = the project's value
  const [thr, setThr] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      THRESHOLDS.filter(([k]) => p.thresholds?.[k] !== undefined).map(([k, , , toUi]) => [
        k,
        String(toUi(p.thresholds[k]!)),
      ]),
    ),
  );
  const [state, setState] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm({
        ...form,
        [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value,
      });
  const run = async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
    setState(`${label}…`);
    try {
      await fn();
      setState('saved');
      (after ?? onSaved)();
    } catch (e) {
      setState(String((e as Error).message));
    }
  };
  const patch = (body: Record<string, unknown>) =>
    api(`/v1/admin/providers/${p.id}`, { method: 'PATCH', body });
  const thresholds = () =>
    Object.fromEntries(
      THRESHOLDS.filter(([k]) => (thr[k] ?? '').trim() !== '').map(([k, , , , fromUi]) => [
        k,
        fromUi(Number(thr[k])),
      ]),
    );
  const save = () =>
    run('saving', () =>
      patch({
        displayName: form.displayName.trim() || null,
        hostPatterns: lines(form.hosts),
        explicitRoutes: lines(form.routes),
        supportEmail: form.supportEmail || null,
        supportUrl: form.supportUrl || null,
        supportNotes: form.supportNotes || null,
        alertsEnabled: form.alertsEnabled,
        pathPrivacy: form.pathPrivacy || null,
        allowedPathWords: allowedWords(form.allowedPathWords).words,
        // thresholds and what the status page shows are for admins
        ...(isAdmin
          ? {
              thresholds: thresholds(),
              publicDisplayName: form.publicDisplayName || null,
              isPublic: form.isPublic,
            }
          : {}),
      }),
    );
  const label = labelOf(p);

  return (
    <div className="provider-panel" data-testid="provider-panel">
      <p>
        <span className="tag">{SOURCE_LABEL[p.source]}</span>
        {p.hidden && <span className="tag red">hidden</span>}
        {p.internal && <span className="tag">internal</span>}{' '}
        <span className="muted">
          first seen {ago(p.firstSeenAt)}
          {p.lastCallAt ? `, last call ${ago(p.lastCallAt)}` : ', never called'}
        </span>
      </p>

      <Section title="General">
        <div className="form">
          <label>
            Name <small>the key data is stored under</small>
            <input value={p.name} readOnly />
          </label>
          <label>
            Name in the dashboard <small>rename; data stays under {p.name}</small>
            <input value={form.displayName} onChange={set('displayName')} placeholder={p.name} />
          </label>
          <label>
            Category{' '}
            <small>from the catalog or discovery; infrastructure starts with alerts off</small>
            <input value={p.category ?? 'other'} readOnly />
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
            Support notes <small>added to the incident summary</small>
            <textarea rows={2} value={form.supportNotes} onChange={set('supportNotes')} />
          </label>
        </div>
      </Section>

      <Section title="Hosts & routes">
        {p.hosts.length > 0 && (
          <div className="hosts">
            <span className="muted">Hosts seen:</span>
            {p.hosts.map((h) => (
              <span key={h} className="host">
                <code>{h}</code>
                {hostCount(p) > 1 && (
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
            Host patterns{' '}
            <small>one per line (`api.x.com`, `*.x.io`); hosts matching them belong here</small>
            <textarea rows={2} value={form.hosts} onChange={set('hosts')} />
          </label>
          <label>
            Explicit routes{' '}
            <small>`/v1/users/:userId`; sent to the SDK, override auto-templating</small>
            <textarea rows={2} value={form.routes} onChange={set('routes')} />
          </label>
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
                    {labelOf(o)}
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
                    !confirm(`Merge ${label} into ${labelOf(target)}? Its history moves too.`)
                  )
                    return;
                  void run(
                    'merging',
                    () =>
                      api(`/v1/admin/providers/${p.id}/merge`, {
                        method: 'POST',
                        body: { into: target.id },
                      }),
                    () => (window.location.hash = href('settings', 'providers', target.name)),
                  );
                }}
              >
                Merge
              </button>
            </span>
          )}
        </div>
      </Section>

      <Section title="Endpoint names">
        <div className="form">
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
              sent as-is in strict mode, e.g. this provider&apos;s resource or method names (
              <code>getLatestOrdSumStatus</code>); never names or other personal data
            </small>
            <input
              value={form.allowedPathWords}
              onChange={set('allowedPathWords')}
              placeholder="sneakers getOrderHistory"
            />
            <AllowedWordsPreview input={form.allowedPathWords} saved={p.allowedPathWords} />
          </label>
        </div>
      </Section>

      <Section title="Alerts & thresholds" admin="thresholds: admins only, read-only">
        <label className="check">
          <input type="checkbox" checked={form.alertsEnabled} onChange={set('alertsEnabled')} />{' '}
          Alerts on <small className="muted">(incidents are tracked either way)</small>
        </label>
        <table className="table thresholds" data-testid="thresholds">
          <thead>
            <tr>
              <th>Rule</th>
              <th className="num">Project default</th>
              <th className="num">This provider</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {THRESHOLDS.map(([k, text, unit, toUi]) => {
              const own = (thr[k] ?? '').trim() !== '';
              return (
                <tr key={k}>
                  <td>{text}</td>
                  <td className="num muted">
                    {project[k] !== undefined ? `${toUi(project[k])} ${unit}` : '–'}
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step="any"
                      min={0}
                      aria-label={text}
                      value={thr[k] ?? ''}
                      placeholder="default"
                      disabled={!isAdmin}
                      onChange={(e) => setThr({ ...thr, [k]: e.target.value })}
                    />{' '}
                    {own ? <span className="tag">override</span> : null}
                  </td>
                  <td>
                    {own && isAdmin && (
                      <button
                        className="btn small"
                        onClick={() =>
                          setThr(Object.fromEntries(Object.entries(thr).filter(([x]) => x !== k)))
                        }
                      >
                        Reset to default
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title="Public status page" admin="admins only, read-only">
        <div className="form">
          <label className="check">
            <input
              type="checkbox"
              checked={form.isPublic}
              onChange={set('isPublic')}
              disabled={!isAdmin}
            />{' '}
            Show on the public status page
          </label>
          <label>
            Public display name <small>shown on the status page instead of the provider name</small>
            <input
              value={form.publicDisplayName}
              onChange={set('publicDisplayName')}
              placeholder="Card issuing"
              disabled={!isAdmin}
            />
          </label>
        </div>
      </Section>

      <div className="panel-save">
        <button className="btn primary" onClick={() => void save()}>
          Save
        </button>{' '}
        <span className="muted" data-testid="provider-save-state">
          {state}
        </span>
      </div>
    </div>
  );
}

/**
 * Allowed path words as typed (space or comma separated) → the normalized form
 * the SDK compares path segments in (`_ah` → `ah`, `getLatestOrdSumStatus` →
 * `getlatestordsumstatus`), and the entries that can't be a word.
 */
export function allowedWords(input: string): { words: string[]; invalid: string[] } {
  const words: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,]+/).filter(Boolean)) {
    const w = normalizePathWord(raw);
    if (ALLOWED_WORD.test(w)) {
      if (!words.includes(w)) words.push(w);
    } else invalid.push(raw);
  }
  return { words, invalid };
}

/** What will be saved, so nothing changes silently. */
function AllowedWordsPreview({ input, saved }: { input: string; saved: string[] }) {
  const { words, invalid } = allowedWords(input);
  const typed = input.split(/[\s,]+/).filter(Boolean);
  const changed = words.join(' ') !== typed.join(' ').toLowerCase();
  if (!changed && invalid.length === 0 && words.join(' ') === saved.join(' ')) return null;
  return (
    <small data-testid="allowed-words-preview">
      {words.length > 0 && (
        <>
          saved as{' '}
          {words
            .map((w) => <code key={w}>{w}</code>)
            .reduce<ReactNode[]>((a, c, i) => (i ? [...a, ' ', c] : [c]), [])}{' '}
          (lower-case, _ - . removed; path segments are compared the same way)
        </>
      )}
      {invalid.length > 0 && (
        <span className="bad">
          {' '}
          not saved: {invalid.join(', ')} (letters and digits only, up to 64)
        </span>
      )}
    </small>
  );
}
