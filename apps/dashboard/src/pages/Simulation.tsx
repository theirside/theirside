/**
 * Simulation page (THEIRSIDE_SIM=1 only; docs/demo.md "Simulate weeks in minutes"):
 * the simulated clock, the scenario builder (sources, faults on a timeline,
 * expectations), the live timeline of faults, incidents and alerts, and the
 * ready-made and saved scenarios. Everything goes through the scenario format the
 * CLI runs (`pnpm sim`), via the /__sim API.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { api } from '../api';
import {
  Badge,
  Button,
  Callout,
  Card,
  Empty,
  ErrorBox,
  Field,
  Segmented,
  Table,
  usePoll,
} from '../components/ui';
import { href } from '../router';
import { Help, HelpProvider, useHelp } from './SimReference';

// ------------------------------------------------------------------ types (mirror src/sim/scenario.ts)

type Pattern = 'steady' | 'daily' | 'low' | 'bursty' | 'test-bursts' | 'rare' | 'off';
const PATTERNS: Pattern[] = ['steady', 'daily', 'low', 'bursty', 'test-bursts', 'rare', 'off'];
const OUT_FAULTS = ['5xx', 'timeouts', 'resets', 'auth', 'not_found', 'validation', 'latency'];
const IN_FAULTS = ['silent', 'rejected', 'slow', 'late'];

interface Traffic {
  pattern: Pattern;
  rate?: number;
  perHour?: number;
  perDay?: number;
  night?: number;
  weekend?: number;
  holidays?: number[];
  clumpSize?: number;
  clumpEvery?: number;
  burstMinutes?: [number, number];
  idleHours?: [number, number];
  schedule?: string[];
}
interface Endpoint {
  id?: string;
  method: string;
  path: string;
  traffic: Traffic;
  normal: { errors?: number; notFound?: number; validation?: number; latencyMs?: number };
}
interface Provider {
  name: string;
  host?: string;
  endpoints: Endpoint[];
}
interface Webhook {
  id?: string;
  provider: string;
  route: string;
  traffic: Traffic;
  normal: { rejected?: number; handlerMs?: number; lagS?: number };
}
interface Fault {
  id: string;
  target: string;
  at: string;
  duration: string;
  type: string;
  size?: number;
  ramp?: boolean;
  status?: number;
}
type Expectation =
  | { incident: { kind?: string | string[]; target?: string; fault: string; within: string } }
  | { quiet: { from: string; to: string; target?: string } }
  | { irregular: { target: string; by: string } };
interface Scenario {
  name: string;
  description?: string;
  start: string;
  duration: string;
  seed: number;
  environment: string;
  history: { mode: 'empty' } | { mode: 'seeded'; days: number; traffic?: Traffic };
  providers: Provider[];
  webhooks: Webhook[];
  faults: Fault[];
  expect: Expectation[];
}
interface TimelineEvent {
  at: number;
  type: 'fault_start' | 'fault_end' | 'opened' | 'resolved' | 'kind' | 'alert';
  text: string;
  incidentId?: string;
  provider?: string;
  muted?: boolean;
}
interface ExpectationState {
  label: string;
  status: 'pending' | 'pass' | 'fail';
  detail: string;
}
interface SimState {
  status: 'idle' | 'loading' | 'ready' | 'running' | 'jumping' | 'paused' | 'finished';
  scenario: Scenario | null;
  now: number;
  start: number | null;
  end: number | null;
  speed: number | 'max';
  paused: boolean;
  /** Where a jump in progress stops, or null. */
  jumpTo: number | null;
  realElapsedMs: number;
  minutesPerSecond: number;
  timeline: TimelineEvent[];
  timelineTotal: number;
  expectations: ExpectationState[];
  error: string | null;
}
export interface SimClockView {
  now: string;
  start: string | null;
  end: string | null;
  speed: number | 'max';
  paused: boolean;
  status: SimState['status'];
  jumpTo: string | null;
  realElapsedMs: number;
  minutesPerSecond: number;
}

// ------------------------------------------------------------------ time helpers (same forms as the YAML)

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function parseDur(s: string): number | null {
  let total = 0;
  let rest = s.replace(/\s/g, '');
  if (!rest) return null;
  const re = /^(\d+(?:\.\d+)?)(w|d|h|m)/;
  while (rest) {
    const m = re.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * { w: 7 * DAY, d: DAY, h: HOUR, m: MIN }[m[2] as 'w' | 'd' | 'h' | 'm'];
    rest = rest.slice(m[0].length);
  }
  return total;
}
export function parseAt(s: string, start: number): number | null {
  const t = s.trim();
  const d = /^(?:day|d)\s*(\d+)(?:\s+(\d{1,2}):(\d{2}))?$/i.exec(t);
  if (d) return start + Number(d[1]) * DAY + Number(d[2] ?? 0) * HOUR + Number(d[3] ?? 0) * MIN;
  if (t.startsWith('+')) {
    const x = parseDur(t.slice(1));
    return x === null ? null : start + x;
  }
  const abs = Date.parse(t);
  return Number.isFinite(abs) ? abs : null;
}
export function fmtAt(ms: number, start: number): string {
  const off = Math.max(0, ms - start);
  const d = Math.floor(off / DAY);
  const r = off - d * DAY;
  return `day ${d} ${String(Math.floor(r / HOUR)).padStart(2, '0')}:${String(Math.floor((r % HOUR) / MIN)).padStart(2, '0')}`;
}
/** A simulated duration: "3d 4h", "5h 20m", "12m". */
const fmtDur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / MIN));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
};
const fmtElapsed = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s} s`
    : s < 3600
      ? `${Math.floor(s / 60)} min ${s % 60} s`
      : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
export const simDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' UTC';

const outId = (p: string, e: Endpoint) => e.id ?? `${p} ${e.method.toUpperCase()} ${e.path}`;
const inId = (w: Webhook) => w.id ?? `${w.provider} webhooks ${w.route}`;
const sourceIds = (s: Scenario) => [
  ...s.providers.flatMap((p) => p.endpoints.map((e) => ({ id: outId(p.name, e), inbound: false }))),
  ...s.webhooks.map((w) => ({ id: inId(w), inbound: true })),
];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const SPEEDS = ['1×', '60×', '600×', '3600×', 'max'] as const;
type SpeedLabel = (typeof SPEEDS)[number];
const speedLabel = (s: number | 'max'): SpeedLabel =>
  s === 'max' ? 'max' : (SPEEDS.find((x) => x === `${s}×`) ?? '3600×');
const speedValue = (l: SpeedLabel): number | 'max' =>
  l === 'max' ? 'max' : Number(l.replace('×', ''));

// ------------------------------------------------------------------ banner (every page)

/** Simulated time, speed and "simulation data", on every page in simulation mode. */
export function SimBanner({ clock }: { clock: SimClockView | null }) {
  if (!clock) return null;
  const now = Date.parse(clock.now);
  return (
    <div className="sim-banner" role="status" data-testid="sim-banner">
      <strong>Simulation data</strong>
      <span>{simDate(now)}</span>
      <span>
        {clock.status === 'jumping' && clock.jumpTo
          ? `jumping ahead to ${simDate(Date.parse(clock.jumpTo))}`
          : clock.paused || clock.status !== 'running'
            ? clock.status === 'finished'
              ? 'finished'
              : 'paused'
            : `${clock.speed === 'max' ? 'max speed' : `${clock.speed}×`}${clock.minutesPerSecond ? ` (≈ ${Math.round(clock.minutesPerSecond * 60)}×)` : ''}`}
      </span>
      <a href={href('simulation')}>Simulation</a>
    </div>
  );
}

// ------------------------------------------------------------------ page

export function Simulation() {
  const [state, setState] = useState<SimState | null>(null);
  const [error, setError] = useState<unknown>();
  const timeline = useRef<TimelineEvent[]>([]);
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'info' | 'warning' | 'danger';
    text: string;
    restart?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const loadedName = useRef<string | null>(null);

  // poll the engine; the timeline comes in increments
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const known = timeline.current.length;
        const s = await api<SimState>(`/__sim/state?since=${known}`);
        if (!alive) return;
        if (s.timelineTotal < known) {
          timeline.current = [];
          const full = await api<SimState>('/__sim/state?since=0');
          timeline.current = full.timeline;
          setState({ ...full, timeline: timeline.current });
        } else {
          timeline.current = [...timeline.current, ...s.timeline];
          setState({ ...s, timeline: timeline.current });
        }
        setError(undefined);
      } catch (e) {
        if (alive) setError(e);
      }
    };
    void run();
    const t = setInterval(() => void run(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // a newly loaded scenario replaces the editor's copy (unless it has unapplied edits)
  useEffect(() => {
    if (!state?.scenario) return;
    const key = `${state.scenario.name}|${state.start}`;
    if (loadedName.current !== key && !dirty) {
      loadedName.current = key;
      setDraft(clone(state.scenario));
    }
  }, [state?.scenario, state?.start, dirty]);

  const edit = (fn: (s: Scenario) => void) =>
    setDraft((d) => {
      if (!d) return d;
      const n = clone(d);
      fn(n);
      setDirty(true);
      return n;
    });

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) setNotice({ tone: 'info', text: ok });
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const loadScenario = (body: Record<string, unknown>, ok: string) =>
    act(async () => {
      await api('/__sim/load', { method: 'POST', body });
      // take the loaded scenario into the editor now, so no poll in between can mix old and new
      const full = await api<SimState>('/__sim/state?since=0');
      timeline.current = full.timeline;
      setState({ ...full, timeline: timeline.current });
      loadedName.current = full.scenario ? `${full.scenario.name}|${full.start}` : null;
      setDraft(full.scenario ? clone(full.scenario) : null);
      setDirty(false);
    }, ok);

  const apply = () =>
    act(async () => {
      if (!draft) return;
      const r = await api<{ applied: boolean; restartRequired: string | null }>('/__sim/scenario', {
        method: 'PUT',
        body: { scenario: draft },
      });
      if (r.applied) {
        setDirty(false);
        setNotice({
          tone: 'info',
          text: 'Applied live: traffic, normal levels, future faults and expectations follow the edit from the next simulated minute.',
        });
      } else
        setNotice({
          tone: 'warning',
          text: `These changes need a restart: ${r.restartRequired}. Restarting resets the simulation database.`,
          restart: true,
        });
    });

  if (error && !state) return <ErrorBox error={error} />;
  if (!state) return null;
  const start = state.start ?? Date.parse(draft?.start ?? '2026-01-05T00:00:00Z');
  const end = state.end ?? start + (parseDur(draft?.duration ?? '7d') ?? 7 * DAY);

  return (
    <HelpProvider>
      <div className="page sim" data-testid="simulation">
        <div className="sim-title">
          <h1>Simulation</h1>
          <ReferenceButton />
        </div>
        <p className="muted">
          Synthetic traffic on a simulated clock, through the real detection, incidents and alerts.
          Local use only: everything here is simulation data in a simulation database.
        </p>
        {notice && (
          <Callout tone={notice.tone}>
            {notice.text}{' '}
            {notice.restart && draft && (
              <Button
                size="small"
                disabled={busy}
                onClick={() =>
                  void loadScenario({ scenario: draft }, 'Restarted with your changes.')
                }
              >
                Restart with these changes
              </Button>
            )}{' '}
            <Button size="small" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </Callout>
        )}
        {state.error && <Callout tone="danger">The simulation stopped: {state.error}</Callout>}
        <ClockCard state={state} busy={busy} act={act} />
        <ScenariosCard
          state={state}
          draft={draft}
          busy={busy}
          onLoad={loadScenario}
          onDuplicate={(s) => {
            setDraft({ ...s, name: `${s.name}-copy` });
            setDirty(true);
            setNotice({
              tone: 'info',
              text: `Copied "${s.name}": edit it, save it under a new name, then restart with it.`,
            });
          }}
          act={act}
        />
        {draft ? (
          <>
            <Card
              title={`Scenario: ${draft.name}`}
              actions={
                <>
                  {dirty && <Badge tone="warning">unapplied changes</Badge>}
                  <Button
                    variant="primary"
                    disabled={busy || !dirty || !state.scenario}
                    onClick={() => void apply()}
                  >
                    Apply changes
                  </Button>
                  <Button
                    disabled={busy || !dirty}
                    onClick={() => {
                      setDraft(state.scenario ? clone(state.scenario) : draft);
                      setDirty(false);
                    }}
                  >
                    Discard
                  </Button>
                </>
              }
            >
              <ScenarioMeta draft={draft} edit={edit} />
            </Card>
            <SourcesCard draft={draft} edit={edit} />
            <FaultsCard draft={draft} edit={edit} start={start} end={end} now={state.now} />
            <ExpectationsCard draft={draft} edit={edit} live={dirty ? null : state.expectations} />
          </>
        ) : (
          <Card title="Scenario">
            <Empty>Load a ready-made scenario above, or a saved one, to start.</Empty>
          </Card>
        )}
        <LiveCard state={state} start={start} />
      </div>
    </HelpProvider>
  );
}

function ReferenceButton() {
  const { open } = useHelp();
  return (
    <Button size="small" data-testid="sim-reference-open" onClick={() => open()}>
      Scenario reference
    </Button>
  );
}

// ------------------------------------------------------------------ clock

function ClockCard({
  state,
  busy,
  act,
}: {
  state: SimState;
  busy: boolean;
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const [custom, setCustom] = useState('6h');
  const running = state.status === 'running' && !state.paused;
  const jumping = state.status === 'jumping' && state.jumpTo !== null;
  // where the current jump started, for its own progress bar
  const jumpFrom = useRef<{ to: number; from: number } | null>(null);
  if (!jumping) jumpFrom.current = null;
  else if (jumpFrom.current?.to !== state.jumpTo)
    jumpFrom.current = { to: state.jumpTo!, from: jumpFrom.current?.from ?? state.now };
  const can = !!state.scenario && state.status !== 'finished' && state.status !== 'loading';
  const advance = (body: Record<string, number>) =>
    act(() => api('/__sim/clock/advance', { method: 'POST', body }));
  const jumpLeft = jumping ? state.jumpTo! - state.now : 0;
  const jumpPct =
    jumping && jumpFrom.current && jumpFrom.current.to > jumpFrom.current.from
      ? Math.min(
          100,
          ((state.now - jumpFrom.current.from) / (jumpFrom.current.to - jumpFrom.current.from)) *
            100,
        )
      : 0;
  const jumpEta =
    jumping && state.minutesPerSecond > 0 ? (jumpLeft / MIN / state.minutesPerSecond) * 1000 : null;
  const pct =
    state.start !== null && state.end !== null
      ? Math.min(100, ((state.now - state.start) / (state.end - state.start)) * 100)
      : 0;
  return (
    <Card title="Clock" data-testid="sim-clock">
      <div className="sim-clock">
        <div>
          <div className="sim-now">{simDate(state.now)}</div>
          <div className="muted">
            {state.start !== null
              ? `${fmtAt(state.now, state.start)} of ${fmtAt(state.end!, state.start)}`
              : 'no scenario loaded'}{' '}
            · {state.status} · real time {fmtElapsed(state.realElapsedMs)}
            {state.minutesPerSecond
              ? ` · ≈ ${Math.round(state.minutesPerSecond * 60)}× actual`
              : ''}
          </div>
          <div className="sim-progress" aria-hidden="true">
            <div style={{ width: `${pct}%` }} />
          </div>
        </div>
        {jumping && (
          <div className="sim-jump" role="status" data-testid="sim-jump">
            <div>
              <strong>Jumping ahead to {fmtAt(state.jumpTo!, state.start!)}</strong>
              <span className="muted">
                {' '}
                · {fmtDur(jumpLeft)} to go
                {jumpEta !== null ? `, about ${fmtElapsed(jumpEta)}` : ''} · then{' '}
                {state.paused ? 'pauses' : 'keeps running'}
              </span>
            </div>
            <div className="sim-progress" aria-hidden="true">
              <div style={{ width: `${jumpPct}%` }} />
            </div>
          </div>
        )}
        <div className="sim-controls">
          {jumping ? (
            <Button
              variant="primary"
              disabled={busy}
              data-testid="sim-stop-jump"
              onClick={() => void act(() => api('/__sim/clock/advance', { method: 'DELETE' }))}
            >
              Stop jump
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || !can}
              data-testid="sim-play"
              onClick={() =>
                void act(() => api('/__sim/clock', { method: 'PUT', body: { paused: running } }))
              }
            >
              {running ? 'Pause' : 'Play'}
            </Button>
          )}
          <Segmented<SpeedLabel>
            label="Speed"
            value={speedLabel(state.speed)}
            options={[...SPEEDS]}
            onChange={(l) =>
              void act(() => api('/__sim/clock', { method: 'PUT', body: { speed: speedValue(l) } }))
            }
          />
        </div>
        <div className="sim-controls">
          <span className="muted">Jump ahead</span>
          <Button
            size="small"
            disabled={busy || !can || jumping}
            onClick={() => void advance({ hours: 1 })}
          >
            1 h
          </Button>
          <Button
            size="small"
            disabled={busy || !can || jumping}
            onClick={() => void advance({ days: 1 })}
          >
            1 day
          </Button>
          <Button
            size="small"
            disabled={busy || !can || jumping}
            onClick={() => void advance({ days: 7 })}
          >
            1 week
          </Button>
          <input
            className="sim-small"
            aria-label="Custom jump (e.g. 6h, 2d)"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <Button
            size="small"
            disabled={busy || !can || jumping || parseDur(custom) === null}
            onClick={() => void advance({ minutes: (parseDur(custom) ?? 0) / MIN })}
          >
            Jump
          </Button>
        </div>
        <p className="muted sim-hint">
          A jump runs every minute in between at max speed (traffic and every job, so baselines and
          incidents come out as in real time), then goes back to paused or running. It takes as long
          as that stretch at max speed
          {state.minutesPerSecond > 0
            ? `: about ${fmtElapsed((DAY / MIN / state.minutesPerSecond) * 1000)} per simulated day at the speed measured now`
            : ': on a laptop with Postgres in Docker, roughly 1–2 minutes per simulated day'}
          .
        </p>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ scenarios

interface ScenarioListItem {
  name: string;
  source: 'example' | 'saved';
  description: string | null;
  error?: string;
}

function ScenariosCard({
  state,
  draft,
  busy,
  onLoad,
  onDuplicate,
  act,
}: {
  state: SimState;
  draft: Scenario | null;
  busy: boolean;
  onLoad: (body: Record<string, unknown>, ok: string) => Promise<void>;
  onDuplicate: (s: Scenario) => void;
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const [list, err, reload] = usePoll(
    () => api<{ scenarios: ScenarioListItem[]; savedDir: string }>('/__sim/scenarios'),
    [],
    60_000,
  );
  const [saveAs, setSaveAs] = useState('');
  const [days, setDays] = useState(14);
  const [yaml, setYaml] = useState<string | null>(null);
  useEffect(() => {
    if (draft) setSaveAs((s) => s || draft.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
  }, [draft]);
  return (
    <Card title="Scenarios" data-testid="sim-scenarios">
      {err ? <ErrorBox error={err} /> : null}
      <Table>
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Description</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list?.scenarios ?? []).map((s) => (
            <tr key={`${s.source}:${s.name}`}>
              <td>
                <code>{s.name}</code> {s.source === 'saved' && <Badge>saved</Badge>}
                {state.scenario?.name === s.name && <Badge tone="info">loaded</Badge>}
              </td>
              <td className="muted">
                {s.error ? <span className="bad">{s.error}</span> : s.description}
              </td>
              <td className="sim-row-actions">
                <Button
                  size="small"
                  disabled={busy || !!s.error}
                  data-testid={`sim-load-${s.name}`}
                  onClick={() =>
                    void onLoad(
                      { name: s.name },
                      `Loaded "${s.name}" (database reset). Press Play.`,
                    )
                  }
                >
                  Load
                </Button>
                <Button
                  size="small"
                  disabled={busy || !!s.error}
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ scenario: Scenario }>(
                        `/__sim/scenarios/${encodeURIComponent(s.name)}`,
                      );
                      onDuplicate(r.scenario);
                    })
                  }
                >
                  Duplicate
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {draft && (
        <div className="sim-controls sim-gap">
          <Button
            disabled={busy}
            onClick={() =>
              void onLoad(
                { scenario: draft, history: { mode: 'empty' } },
                'Restarted from an empty database.',
              )
            }
          >
            Start from empty
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void onLoad(
                { scenario: draft, history: { mode: 'seeded', days } },
                `Restarted with ${days} days of seeded history.`,
              )
            }
          >
            Start with seeded history
          </Button>
          <input
            className="sim-small"
            type="number"
            min={1}
            max={60}
            aria-label="Days of seeded history"
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
          />
          <Help section="history" label="history" />
          <span className="muted">days</span>
          <span className="sim-sep" />
          <input
            className="sim-name"
            aria-label="Save as"
            value={saveAs}
            onChange={(e) => setSaveAs(e.target.value)}
            placeholder="name"
          />
          <Button
            disabled={busy || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(saveAs)}
            onClick={() =>
              void act(
                async () => {
                  const r = await api<{ path: string }>(`/__sim/scenarios/${saveAs}`, {
                    method: 'PUT',
                    body: { scenario: draft },
                  });
                  reload();
                  return r;
                },
                `Saved as ${saveAs}.yaml in ${list?.savedDir ?? 'the saved folder'}.`,
              )
            }
          >
            Save as YAML
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api<{ ok: boolean; yaml?: string; error?: string }>(
                  '/__sim/validate',
                  {
                    method: 'POST',
                    body: { scenario: draft },
                  },
                );
                setYaml(r.ok ? (r.yaml ?? '') : `# invalid: ${r.error}`);
              })
            }
          >
            Show YAML
          </Button>
        </div>
      )}
      {yaml !== null && (
        <div className="sim-gap">
          <pre className="sim-yaml">{yaml}</pre>
          <Button size="small" onClick={() => setYaml(null)}>
            Hide
          </Button>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ meta

function ScenarioMeta({
  draft,
  edit,
}: {
  draft: Scenario;
  edit: (fn: (s: Scenario) => void) => void;
}) {
  return (
    <div className="form sim-form">
      <Field label="Name">
        <input value={draft.name} onChange={(e) => edit((s) => void (s.name = e.target.value))} />
      </Field>
      <Field
        label={
          <>
            Length <Help section="scenario" k="duration" />
          </>
        }
        hint="e.g. 3d, 2w (live)"
      >
        <input
          value={draft.duration}
          onChange={(e) => edit((s) => void (s.duration = e.target.value))}
        />
      </Field>
      <Field
        label={
          <>
            Start (simulated, UTC) <Help section="scenario" k="start" />
          </>
        }
        hint="restart needed"
      >
        <input value={draft.start} onChange={(e) => edit((s) => void (s.start = e.target.value))} />
      </Field>
      <Field
        label={
          <>
            Seed <Help section="scenario" k="seed" />
          </>
        }
        hint="restart needed"
      >
        <input
          type="number"
          value={draft.seed}
          onChange={(e) => edit((s) => void (s.seed = Number(e.target.value) || 1))}
        />
      </Field>
      <Field label="Description" wide>
        <input
          value={draft.description ?? ''}
          onChange={(e) => edit((s) => void (s.description = e.target.value))}
        />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------ sources

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

/** The pattern picker; each option and the picker itself carry the pattern's one-line summary. */
function PatternSelect({ value, onChange }: { value: Pattern; onChange: (v: Pattern) => void }) {
  const { tip } = useHelp();
  return (
    <select
      aria-label="Pattern"
      title={tip('patterns', value)}
      value={value}
      onChange={(ev) => onChange(ev.target.value as Pattern)}
    >
      {PATTERNS.map((x) => (
        <option key={x} title={tip('patterns', x)}>
          {x}
        </option>
      ))}
    </select>
  );
}

function PatternFields({ t, set }: { t: Traffic; set: (fn: (t: Traffic) => void) => void }) {
  const { tip, entry } = useHelp();
  // the setting each short label stands for, for its hover hint
  const KEY: Record<string, keyof Traffic> = {
    'per min': 'rate',
    'per hour': 'perHour',
    'per day': 'perDay',
    clump: 'clumpSize',
    'every min': 'clumpEvery',
    'burst min': 'burstMinutes',
    'idle h': 'idleHours',
    night: 'night',
    weekend: 'weekend',
  };
  const hint = (label: string) => (KEY[label] ? tip('traffic', KEY[label]) : undefined);
  const box = (
    label: string,
    value: number | undefined,
    f: (t: Traffic, v: number | undefined) => void,
    step = 'any',
  ) => (
    <label className="sim-param" title={hint(label)}>
      {label}
      <input
        className="sim-small"
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(e) => set((x) => f(x, num(e.target.value)))}
      />
    </label>
  );
  const pair = (
    label: string,
    value: [number, number] | undefined,
    dflt: [number, number],
    f: (t: Traffic, v: [number, number]) => void,
  ) => (
    <label className="sim-param" title={hint(label)}>
      {label}
      <input
        className="sim-small"
        type="number"
        value={(value ?? dflt)[0]}
        onChange={(e) => set((x) => f(x, [Number(e.target.value) || 0, (value ?? dflt)[1]]))}
      />
      –
      <input
        className="sim-small"
        type="number"
        value={(value ?? dflt)[1]}
        onChange={(e) => set((x) => f(x, [(value ?? dflt)[0], Number(e.target.value) || 0]))}
      />
    </label>
  );
  const p = t.pattern;
  return (
    <div className="sim-params">
      {(p === 'steady' || p === 'daily' || p === 'test-bursts' || p === 'bursty') &&
        box('per min', t.rate, (x, v) => void (x.rate = v))}
      {p === 'low' && box('per hour', t.perHour, (x, v) => void (x.perHour = v))}
      {p === 'rare' && box('per day', t.perDay, (x, v) => void (x.perDay = v))}
      {p === 'bursty' && box('clump', t.clumpSize, (x, v) => void (x.clumpSize = v))}
      {p === 'bursty' && box('every min', t.clumpEvery, (x, v) => void (x.clumpEvery = v))}
      {p === 'test-bursts' &&
        pair('burst min', t.burstMinutes, [60, 120], (x, v) => void (x.burstMinutes = v))}
      {p === 'test-bursts' &&
        pair('idle h', t.idleHours, [12, 36], (x, v) => void (x.idleHours = v))}
      {p !== 'off' &&
        p !== 'test-bursts' &&
        box('night', t.night, (x, v) => void (x.night = v), '0.05')}
      {p !== 'off' &&
        p !== 'test-bursts' &&
        box('weekend', t.weekend, (x, v) => void (x.weekend = v), '0.05')}
      <span className="sim-param-hint muted">
        {entry('patterns', p)?.summary.replace(/`/g, '')}
      </span>
    </div>
  );
}

/** Renaming a source keeps faults and expectations pointing at it. */
function retarget(s: Scenario, from: string, to: string) {
  if (from === to) return;
  for (const f of s.faults) if (f.target === from) f.target = to;
  for (const e of s.expect) {
    if ('incident' in e && e.incident.target === from) e.incident.target = to;
    if ('quiet' in e && e.quiet.target === from) e.quiet.target = to;
    if ('irregular' in e && e.irregular.target === from) e.irregular.target = to;
  }
}

function SourcesCard({
  draft,
  edit,
}: {
  draft: Scenario;
  edit: (fn: (s: Scenario) => void) => void;
}) {
  const pct = (v: number | undefined) =>
    v === undefined ? '' : String(Math.round(v * 10000) / 100);
  const fromPct = (v: string) => (v.trim() === '' ? undefined : Number(v) / 100);
  return (
    <Card
      title="Sources"
      actions={
        <>
          <Button
            size="small"
            onClick={() =>
              edit((s) =>
                s.providers.push({
                  name: `Provider${s.providers.length + 1}`,
                  endpoints: [
                    {
                      method: 'GET',
                      path: '/v1/items',
                      traffic: { pattern: 'daily', rate: 20 },
                      normal: {},
                    },
                  ],
                }),
              )
            }
          >
            Add provider
          </Button>
          <Button
            size="small"
            onClick={() =>
              edit((s) =>
                s.webhooks.push({
                  provider: 'NotifyCo',
                  route: `/webhooks/source${s.webhooks.length + 1}`,
                  traffic: { pattern: 'steady', rate: 5 },
                  normal: {},
                }),
              )
            }
          >
            Add webhook source
          </Button>
        </>
      }
    >
      <p className="muted">
        Traffic and normal levels apply live; adding, removing or renaming sources needs a restart.
      </p>
      <Table className="sim-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Endpoint</th>
            <th>
              Pattern <Help section="patterns" label="traffic patterns" />
            </th>
            <th>
              Parameters <Help section="traffic" label="traffic settings" />
            </th>
            <th className="num">
              Errors % <Help section="normal-outbound" k="errors" />
            </th>
            <th className="num">
              Latency ms <Help section="normal-outbound" k="latencyMs" />
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.providers.flatMap((p, pi) =>
            p.endpoints.map((e, ei) => (
              <tr key={`${pi}:${ei}`}>
                <td>
                  {ei === 0 ? (
                    <input
                      className="sim-name"
                      aria-label="Provider name"
                      value={p.name}
                      onChange={(ev) =>
                        edit((s) => {
                          const pr = s.providers[pi]!;
                          const old = pr.endpoints.map((x) => outId(pr.name, x));
                          pr.name = ev.target.value;
                          pr.endpoints.forEach((x, i) => retarget(s, old[i]!, outId(pr.name, x)));
                        })
                      }
                    />
                  ) : (
                    <span className="muted">{p.name}</span>
                  )}
                  {ei === 0 && (
                    <Button
                      size="small"
                      onClick={() =>
                        edit((s) =>
                          s.providers[pi]!.endpoints.push({
                            method: 'GET',
                            path: '/v1/other',
                            traffic: { pattern: 'daily', rate: 10 },
                            normal: {},
                          }),
                        )
                      }
                    >
                      + endpoint
                    </Button>
                  )}
                </td>
                <td>
                  <select
                    aria-label="Method"
                    value={e.method}
                    onChange={(ev) =>
                      edit((s) => {
                        const pr = s.providers[pi]!;
                        const x = pr.endpoints[ei]!;
                        const old = outId(pr.name, x);
                        x.method = ev.target.value;
                        retarget(s, old, outId(pr.name, x));
                      })
                    }
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>{' '}
                  <input
                    className="sim-path"
                    aria-label="Path"
                    value={e.path}
                    onChange={(ev) =>
                      edit((s) => {
                        const pr = s.providers[pi]!;
                        const x = pr.endpoints[ei]!;
                        const old = outId(pr.name, x);
                        x.path = ev.target.value;
                        retarget(s, old, outId(pr.name, x));
                      })
                    }
                  />
                </td>
                <td>
                  <PatternSelect
                    value={e.traffic.pattern}
                    onChange={(v) =>
                      edit((s) => void (s.providers[pi]!.endpoints[ei]!.traffic.pattern = v))
                    }
                  />
                </td>
                <td>
                  <PatternFields
                    t={e.traffic}
                    set={(fn) => edit((s) => fn(s.providers[pi]!.endpoints[ei]!.traffic))}
                  />
                </td>
                <td className="num">
                  <input
                    className="sim-small"
                    type="number"
                    step="0.1"
                    aria-label="Normal provider errors %"
                    value={pct(e.normal.errors)}
                    onChange={(ev) =>
                      edit(
                        (s) =>
                          void (s.providers[pi]!.endpoints[ei]!.normal.errors = fromPct(
                            ev.target.value,
                          )),
                      )
                    }
                  />
                </td>
                <td className="num">
                  <input
                    className="sim-small"
                    type="number"
                    aria-label="Normal median latency ms"
                    value={e.normal.latencyMs ?? ''}
                    onChange={(ev) =>
                      edit(
                        (s) =>
                          void (s.providers[pi]!.endpoints[ei]!.normal.latencyMs = num(
                            ev.target.value,
                          )),
                      )
                    }
                  />
                </td>
                <td>
                  <Button
                    size="small"
                    onClick={() =>
                      edit((s) => {
                        const pr = s.providers[pi]!;
                        pr.endpoints.splice(ei, 1);
                        if (pr.endpoints.length === 0) s.providers.splice(pi, 1);
                      })
                    }
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            )),
          )}
        </tbody>
      </Table>
      <Table className="sim-table">
        <thead>
          <tr>
            <th>Webhook sender</th>
            <th>Route</th>
            <th>
              Pattern <Help section="patterns" label="traffic patterns" />
            </th>
            <th>
              Parameters <Help section="traffic" label="traffic settings" />
            </th>
            <th className="num">
              Rejected % <Help section="normal-inbound" k="rejected" />
            </th>
            <th className="num">
              Handler ms <Help section="normal-inbound" k="handlerMs" />
            </th>
            <th className="num">
              Lag s <Help section="normal-inbound" k="lagS" />
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.webhooks.map((w, wi) => (
            <tr key={wi}>
              <td>
                <input
                  className="sim-name"
                  aria-label="Sender"
                  value={w.provider}
                  onChange={(ev) =>
                    edit((s) => {
                      const x = s.webhooks[wi]!;
                      const old = inId(x);
                      x.provider = ev.target.value;
                      retarget(s, old, inId(x));
                    })
                  }
                />
              </td>
              <td>
                <input
                  className="sim-path"
                  aria-label="Route"
                  value={w.route}
                  onChange={(ev) =>
                    edit((s) => {
                      const x = s.webhooks[wi]!;
                      const old = inId(x);
                      x.route = ev.target.value;
                      retarget(s, old, inId(x));
                    })
                  }
                />
              </td>
              <td>
                <PatternSelect
                  value={w.traffic.pattern}
                  onChange={(v) => edit((s) => void (s.webhooks[wi]!.traffic.pattern = v))}
                />
              </td>
              <td>
                <PatternFields
                  t={w.traffic}
                  set={(fn) => edit((s) => fn(s.webhooks[wi]!.traffic))}
                />
              </td>
              <td className="num">
                <input
                  className="sim-small"
                  type="number"
                  step="0.1"
                  aria-label="Normal rejected %"
                  value={pct(w.normal.rejected)}
                  onChange={(ev) =>
                    edit((s) => void (s.webhooks[wi]!.normal.rejected = fromPct(ev.target.value)))
                  }
                />
              </td>
              <td className="num">
                <input
                  className="sim-small"
                  type="number"
                  aria-label="Normal handler ms"
                  value={w.normal.handlerMs ?? ''}
                  onChange={(ev) =>
                    edit((s) => void (s.webhooks[wi]!.normal.handlerMs = num(ev.target.value)))
                  }
                />
              </td>
              <td className="num">
                <input
                  className="sim-small"
                  type="number"
                  step="0.1"
                  aria-label="Normal lag s"
                  value={w.normal.lagS ?? ''}
                  onChange={(ev) =>
                    edit((s) => void (s.webhooks[wi]!.normal.lagS = num(ev.target.value)))
                  }
                />
              </td>
              <td>
                <Button size="small" onClick={() => edit((s) => void s.webhooks.splice(wi, 1))}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

// ------------------------------------------------------------------ faults

function FaultsCard({
  draft,
  edit,
  start,
  end,
  now,
}: {
  draft: Scenario;
  edit: (fn: (s: Scenario) => void) => void;
  start: number;
  end: number;
  now: number;
}) {
  const help = useHelp();
  const ids = sourceIds(draft);
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; dx: number } | null>(null);
  const span = Math.max(MIN, end - start);
  const toX = (ms: number) => ((ms - start) / span) * 100;
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const el = lane.current;
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left - d.dx) / r.width));
    // snap to 15 simulated minutes
    const at = start + Math.round((frac * span) / (15 * MIN)) * 15 * MIN;
    edit((s) => void (s.faults[d.index]!.at = fmtAt(at, start)));
  };
  const days = Math.ceil(span / DAY);
  return (
    <Card
      title="Faults"
      actions={
        <Button
          size="small"
          disabled={ids.length === 0}
          onClick={() =>
            edit((s) => {
              const target = ids[0]!;
              s.faults.push({
                id: `fault${s.faults.length + 1}`,
                target: target.id,
                at: fmtAt(start + Math.min(span / 2, DAY + 14 * HOUR), start),
                duration: '30m',
                type: target.inbound ? 'silent' : '5xx',
                size: target.inbound ? undefined : 0.3,
              });
            })
          }
        >
          Add fault
        </Button>
      }
    >
      <p className="muted">
        Drag a fault along the timeline, or edit it in the table. Faults that haven't started yet
        change live.
      </p>
      <div
        className="sim-lane"
        ref={lane}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
        data-testid="sim-fault-lane"
      >
        {Array.from({ length: days + 1 }, (_, d) => (
          <span key={d} className="sim-tick" style={{ left: `${(d * DAY * 100) / span}%` }}>
            {days <= 31 || d % 7 === 0 ? `day ${d}` : ''}
          </span>
        ))}
        <span
          className="sim-now-line"
          style={{ left: `${Math.min(100, Math.max(0, toX(now)))}%` }}
        />
        {draft.faults.map((f, i) => {
          const from = parseAt(f.at, start);
          const len = parseDur(f.duration);
          if (from === null || len === null) return null;
          return (
            <div
              key={i}
              className="sim-fault"
              role="slider"
              aria-label={`${f.id} at ${f.at}`}
              aria-valuenow={from}
              tabIndex={0}
              title={`${f.id}: ${f.type} on ${f.target}, ${f.at} for ${f.duration}`}
              style={{
                left: `${toX(from)}%`,
                width: `max(${(len / span) * 100}%, 6px)`,
                top: `${18 + (i % 3) * 22}px`,
              }}
              onPointerDown={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                drag.current = { index: i, dx: e.clientX - r.left };
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              }}
            >
              {f.id}
            </div>
          );
        })}
      </div>
      <Table className="sim-table">
        <thead>
          <tr>
            <th>Fault</th>
            <th>Source</th>
            <th>
              When <Help section="times" label="times" />
            </th>
            <th>
              Type <Help section="fault-types" label="fault types" />
            </th>
            <th className="num">
              Size <Help section="faults" k="size" />
            </th>
            <th>
              Duration <Help section="faults" k="duration" />
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.faults.map((f, i) => {
            const target = ids.find((x) => x.id === f.target);
            const types = target?.inbound ? IN_FAULTS : OUT_FAULTS;
            return (
              <tr key={i}>
                <td>
                  <input
                    className="sim-name"
                    aria-label="Fault id"
                    value={f.id}
                    onChange={(e) =>
                      edit((s) => {
                        const old = s.faults[i]!.id;
                        s.faults[i]!.id = e.target.value;
                        for (const x of s.expect)
                          if ('incident' in x && x.incident.fault === old)
                            x.incident.fault = e.target.value;
                      })
                    }
                  />
                </td>
                <td>
                  <select
                    aria-label="Fault source"
                    value={f.target}
                    onChange={(e) =>
                      edit((s) => {
                        const x = s.faults[i]!;
                        x.target = e.target.value;
                        const inbound = ids.find((y) => y.id === x.target)?.inbound;
                        if (inbound && !IN_FAULTS.includes(x.type)) x.type = 'silent';
                        if (!inbound && !OUT_FAULTS.includes(x.type)) x.type = '5xx';
                      })
                    }
                  >
                    {ids.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.id}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="sim-when"
                    aria-label="Fault time"
                    value={f.at}
                    onChange={(e) => edit((s) => void (s.faults[i]!.at = e.target.value))}
                  />
                </td>
                <td>
                  <select
                    aria-label="Fault type"
                    title={help.tip('fault-types', f.type)}
                    value={f.type}
                    onChange={(e) => edit((s) => void (s.faults[i]!.type = e.target.value))}
                  >
                    {types.map((t) => (
                      <option key={t} title={help.tip('fault-types', t)}>
                        {t}
                      </option>
                    ))}
                  </select>
                  {f.type === 'latency' && (
                    <label className="sim-param">
                      <input
                        type="checkbox"
                        checked={!!f.ramp}
                        onChange={(e) =>
                          edit((s) => void (s.faults[i]!.ramp = e.target.checked || undefined))
                        }
                      />
                      ramp
                    </label>
                  )}
                </td>
                <td className="num">
                  <input
                    className="sim-small"
                    type="number"
                    step="any"
                    aria-label="Fault size"
                    title={help.tip('fault-types', f.type)}
                    placeholder={help.entry('fault-types', f.type)?.default}
                    value={f.size ?? ''}
                    onChange={(e) => edit((s) => void (s.faults[i]!.size = num(e.target.value)))}
                  />
                </td>
                <td>
                  <input
                    className="sim-small"
                    aria-label="Fault duration"
                    value={f.duration}
                    onChange={(e) => edit((s) => void (s.faults[i]!.duration = e.target.value))}
                  />
                </td>
                <td>
                  <Button size="small" onClick={() => edit((s) => void s.faults.splice(i, 1))}>
                    Remove
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

// ------------------------------------------------------------------ expectations

const KINDS = [
  'errors',
  'auth',
  'not_found',
  'validation',
  'rate_limited',
  'behaviour',
  'latency',
  'webhook_silence',
  'webhook_rejections',
  'webhook_slow',
  'webhook_lag',
];

function ExpectationsCard({
  draft,
  edit,
  live,
}: {
  draft: Scenario;
  edit: (fn: (s: Scenario) => void) => void;
  live: ExpectationState[] | null;
}) {
  const help = useHelp();
  const ids = sourceIds(draft);
  return (
    <Card
      title="Expectations"
      actions={
        <>
          <Button
            size="small"
            disabled={draft.faults.length === 0}
            onClick={() =>
              edit(
                (s) => void s.expect.push({ incident: { fault: s.faults[0]!.id, within: '10m' } }),
              )
            }
          >
            Add “incident within”
          </Button>
          <Button
            size="small"
            onClick={() =>
              edit((s) => void s.expect.push({ quiet: { from: 'day 0', to: 'day 1' } }))
            }
          >
            Add “no incidents”
          </Button>
        </>
      }
      data-testid="sim-expectations"
    >
      {draft.expect.length === 0 ? (
        <Empty>
          No expectations: add “incident of type X on Y within N minutes of fault F”, or “no
          incidents between A and B”.
        </Empty>
      ) : (
        <Table className="sim-table">
          <thead>
            <tr>
              <th>
                Expectation <Help section="expect" label="expectations" />
              </th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.expect.map((e, i) => {
              const st = live?.[i];
              return (
                <tr key={i}>
                  <td>
                    {'incident' in e ? (
                      <span className="sim-params">
                        incident of type
                        <select
                          aria-label="Incident type"
                          value={typeof e.incident.kind === 'string' ? e.incident.kind : ''}
                          onChange={(ev) =>
                            edit(
                              (s) =>
                                void ((
                                  s.expect[i] as { incident: { kind?: string } }
                                ).incident.kind = ev.target.value || undefined),
                            )
                          }
                        >
                          <option value="">any</option>
                          {KINDS.map((k) => (
                            <option key={k} title={help.tip('kinds', k)}>
                              {k}
                            </option>
                          ))}
                        </select>
                        on
                        <select
                          aria-label="Incident source"
                          value={e.incident.target ?? ''}
                          onChange={(ev) =>
                            edit(
                              (s) =>
                                void ((
                                  s.expect[i] as { incident: { target?: string } }
                                ).incident.target = ev.target.value || undefined),
                            )
                          }
                        >
                          <option value="">the fault's source</option>
                          {ids.map((x) => (
                            <option key={x.id}>{x.id}</option>
                          ))}
                        </select>
                        within
                        <input
                          className="sim-small"
                          aria-label="Within"
                          value={e.incident.within}
                          onChange={(ev) =>
                            edit(
                              (s) =>
                                void ((
                                  s.expect[i] as { incident: { within: string } }
                                ).incident.within = ev.target.value),
                            )
                          }
                        />
                        of fault
                        <select
                          aria-label="Fault"
                          value={e.incident.fault}
                          onChange={(ev) =>
                            edit(
                              (s) =>
                                void ((
                                  s.expect[i] as { incident: { fault: string } }
                                ).incident.fault = ev.target.value),
                            )
                          }
                        >
                          {draft.faults.map((f) => (
                            <option key={f.id}>{f.id}</option>
                          ))}
                        </select>
                      </span>
                    ) : 'quiet' in e ? (
                      <span className="sim-params">
                        no incidents between
                        <input
                          className="sim-when"
                          aria-label="From"
                          value={e.quiet.from}
                          onChange={(ev) =>
                            edit(
                              (s) =>
                                void ((s.expect[i] as { quiet: { from: string } }).quiet.from =
                                  ev.target.value),
                            )
                          }
                        />
                        and
                        <input
                          className="sim-when"
                          aria-label="To"
                          value={e.quiet.to}
                          onChange={(ev) =>
                            edit(
                              (s) =>
                                void ((s.expect[i] as { quiet: { to: string } }).quiet.to =
                                  ev.target.value),
                            )
                          }
                        />
                      </span>
                    ) : (
                      <span>
                        <code>{e.irregular.target}</code> marked irregular by {e.irregular.by}
                      </span>
                    )}
                  </td>
                  <td data-testid={`sim-expect-${i}`}>
                    {st ? (
                      <>
                        <Badge
                          tone={
                            st.status === 'pass'
                              ? 'healthy'
                              : st.status === 'fail'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {st.status}
                        </Badge>{' '}
                        <span className="muted">{st.detail}</span>
                      </>
                    ) : (
                      <span className="muted">apply to evaluate</span>
                    )}
                  </td>
                  <td>
                    <Button size="small" onClick={() => edit((s) => void s.expect.splice(i, 1))}>
                      Remove
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ live

const TONE: Record<TimelineEvent['type'], 'warning' | 'danger' | 'healthy' | 'info' | 'neutral'> = {
  fault_start: 'warning',
  fault_end: 'neutral',
  opened: 'danger',
  resolved: 'healthy',
  kind: 'danger',
  alert: 'info',
};
const LABEL: Record<TimelineEvent['type'], string> = {
  fault_start: 'fault',
  fault_end: 'fault ends',
  opened: 'incident',
  resolved: 'resolved',
  kind: 'incident',
  alert: 'alert',
};

function LiveCard({ state, start }: { state: SimState; start: number }) {
  const [only, setOnly] = useState<'all' | 'incidents'>('all');
  const rows = useMemo(() => {
    const list = state.timeline.filter(
      (e) => only === 'all' || e.type === 'opened' || e.type === 'resolved' || e.type === 'kind',
    );
    return [...list].reverse().slice(0, 300);
  }, [state.timeline, only]);
  return (
    <Card
      title="Live timeline"
      actions={
        <Segmented<'all' | 'incidents'>
          label="Show"
          value={only}
          options={['all', 'incidents']}
          onChange={setOnly}
        />
      }
      data-testid="sim-timeline"
    >
      {rows.length === 0 ? (
        <Empty>
          Nothing yet: faults, incidents and alerts appear here as the simulated clock runs.
        </Empty>
      ) : (
        <Table className="sim-table">
          <tbody>
            {rows.map((e, i) => (
              <tr key={`${e.at}:${i}`}>
                <td className="sim-when-cell">{fmtAt(e.at, start)}</td>
                <td>
                  <Badge tone={TONE[e.type]}>{LABEL[e.type]}</Badge>
                </td>
                <td>
                  {e.incidentId ? <a href={href('incidents', e.incidentId)}>{e.text}</a> : e.text}{' '}
                  {e.provider && (
                    <a className="muted" href={href('providers', e.provider)}>
                      {e.provider}
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
