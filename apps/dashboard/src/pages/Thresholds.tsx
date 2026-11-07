import { useState } from 'react';
import { api, type Provider } from '../api';
import { Badge, Button, Card, ErrorBox, Table, usePoll } from '../components/ui';
import { href } from '../router';
import { useIsAdmin } from '../role';

/**
 * Settings → Thresholds: the project's incident and baseline settings
 * (docs/scoring.md), each with its built-in default, the project override and
 * reset; admins edit, members read. Below: providers that override some of
 * them, linking to their settings.
 */

type Row = [
  key: string,
  label: string,
  unit: string,
  toUi?: (v: number) => number,
  fromUi?: (v: number) => number,
];
const pp = (v: number) => Math.round(v * 10_000) / 100;
const fromPp = (v: number) => v / 100;

const GROUPS: [string, Row[]][] = [
  [
    'Incident rule',
    [
      ['windowMinutes', 'Window for rates and p95', 'min'],
      ['minCalls', 'Minimum calls in the window', 'calls'],
      ['minErrors', 'Minimum provider errors in the window', 'errors'],
      ['rateMultiplier', 'Error rate: multiple of normal', '×'],
      ['rateDeltaPp', 'Error rate: margin above normal', 'pp', pp, fromPp],
      ['maxPValue', 'Statistical test: p-value below', ''],
      ['latencyMultiplier', 'Latency: p95 multiple of normal', '×'],
      ['latencyDeltaMs', 'Latency: p95 margin above normal', 'ms'],
      ['openAfterMinutes', 'Bad minutes in a row to open', 'min'],
      ['resolveAfterMinutes', 'Healthy minutes in a row to resolve', 'min'],
      ['cooldownMinutes', 'Quiet after recovery (no new alert)', 'min'],
      ['escalationFactor', 'Escalate at this multiple of the last alert', '×'],
    ],
  ],
  [
    'Baselines',
    [
      ['baselineDays', 'History used for "normal"', 'days'],
      ['baselineGapMinutes', 'Recent minutes left out of "normal"', 'min'],
      ['learningMinHours', 'Learning until this much history', 'h'],
      ['learningMinCalls', '… and this many calls', 'calls'],
      ['learningDefaultRate', 'Error-rate floor while learning', '%', pp, fromPp],
      ['minBaselineRate', 'Error-rate floor for the statistical test', '%', pp, fromPp],
    ],
  ],
];
const ALL = GROUPS.flatMap(([, rows]) => rows);

interface ThresholdsResponse {
  thresholds: Record<string, number>;
  effective: Record<string, number>;
  defaults: Record<string, number>;
}

export function ThresholdsTab() {
  const isAdmin = useIsAdmin();
  const [data, error, reload] = usePoll(
    () => api<ThresholdsResponse>('/v1/admin/settings/thresholds'),
    [],
    300_000,
  );
  const [providers] = usePoll(
    () => api<{ providers: Provider[] }>('/v1/admin/providers'),
    [],
    60_000,
  );
  return (
    <>
      <ErrorBox error={error} />
      <p className="muted">
        When an endpoint counts as failing or slow, for the whole project. A provider can override
        some of these in its own settings. {!isAdmin && 'Only admins can change them.'}
      </p>
      {data && <ThresholdsForm data={data} onSaved={reload} />}
      <Card title="Providers with their own thresholds">
        <ProviderOverrides providers={providers?.providers ?? []} />
      </Card>
    </>
  );
}

function ThresholdsForm({ data, onSaved }: { data: ThresholdsResponse; onSaved: () => void }) {
  const isAdmin = useIsAdmin();
  const ui = (k: string, v: number) => (ALL.find((r) => r[0] === k)?.[3] ?? ((x: number) => x))(v);
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(data.thresholds).map(([k, v]) => [k, String(ui(k, v))])),
  );
  const [state, setState] = useState('');
  const save = async () => {
    setState('saving…');
    try {
      const thresholds = Object.fromEntries(
        ALL.filter(([k]) => (form[k] ?? '').trim() !== '').map(([k, , , , fromUi]) => [
          k,
          (fromUi ?? ((x: number) => x))(Number(form[k])),
        ]),
      );
      await api('/v1/admin/settings/thresholds', { method: 'PUT', body: { thresholds } });
      setState('saved');
      onSaved();
    } catch (e) {
      setState(String((e as Error).message));
    }
  };
  return (
    <>
      {GROUPS.map(([title, rows]) => (
        <Card key={title} title={title}>
          <Table
            className="thresholds"
            data-testid={`thresholds-${title.toLowerCase().replace(/\W+/g, '-')}`}
          >
            <thead>
              <tr>
                <th>Setting</th>
                <th className="num">Default</th>
                <th className="num">This project</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(([k, label, unit, toUi]) => {
                const own = (form[k] ?? '').trim() !== '';
                const show = toUi ?? ((x: number) => x);
                return (
                  <tr key={k}>
                    <td>{label}</td>
                    <td className="num muted">
                      {data.defaults[k] !== undefined ? `${show(data.defaults[k])} ${unit}` : '–'}
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        step="any"
                        min={0}
                        aria-label={label}
                        value={form[k] ?? ''}
                        placeholder="default"
                        disabled={!isAdmin}
                        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                      />
                    </td>
                    <td>
                      {own && <Badge>override</Badge>}{' '}
                      {own && isAdmin && (
                        <Button
                          size="small"
                          onClick={() =>
                            setForm(
                              Object.fromEntries(Object.entries(form).filter(([x]) => x !== k)),
                            )
                          }
                        >
                          Reset to default
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ))}
      {isAdmin && (
        <div className="panel-save">
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>{' '}
          <span className="muted" data-testid="thresholds-save-state">
            {state}
          </span>
        </div>
      )}
    </>
  );
}

const LABEL: Record<string, string> = Object.fromEntries(ALL.map(([k, label]) => [k, label]));

function ProviderOverrides({ providers }: { providers: Provider[] }) {
  const own = providers.filter((p) => Object.keys(p.thresholds ?? {}).length > 0);
  if (own.length === 0)
    return <div className="empty">No provider overrides the project thresholds.</div>;
  return (
    <Table data-testid="threshold-overrides">
      <thead>
        <tr>
          <th>Provider</th>
          <th>Overrides</th>
        </tr>
      </thead>
      <tbody>
        {own.map((p) => (
          <tr key={p.id}>
            <td>
              <a href={href('settings', 'providers', p.name)}>{p.displayName || p.name}</a>
            </td>
            <td>
              {Object.entries(p.thresholds).map(([k, v]) => (
                <Badge key={k} title={LABEL[k] ?? k}>
                  {LABEL[k] ?? k}: {k === 'rateDeltaPp' ? `${pp(v)} pp` : v}
                </Badge>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
