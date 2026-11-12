/**
 * The scenario reference on the Simulation page: field hints (`Help`, `useHelp().tip`) and
 * the Reference panel. Text and defaults come from the collector (`GET /__sim/reference`,
 * apps/collector/src/sim/reference.ts), the same source as `pnpm sim:help` and
 * docs/simulation-reference.md.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api';
import { Button } from '../components/ui';

export interface RefEntry {
  key: string;
  summary: string;
  detail?: string;
  default?: string;
  uses?: string[];
  example?: string;
}
export interface RefSection {
  id: string;
  title: string;
  intro?: string;
  entries: RefEntry[];
}

interface HelpApi {
  entry: (section: string, key: string) => RefEntry | undefined;
  /** One line for a `title` tooltip: summary and default. */
  tip: (section: string, key: string) => string | undefined;
  open: (section?: string, key?: string) => void;
}

const HelpContext = createContext<HelpApi>({
  entry: () => undefined,
  tip: () => undefined,
  open: () => {},
});
export const useHelp = () => useContext(HelpContext);

/** `code` spans in the reference text. */
const md = (text: string): ReactNode =>
  text
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
    );

/** For `title` tooltips: plain text. */
const plain = (text: string) => text.replace(/`/g, '');

const anchor = (section: string, key?: string) =>
  `simref-${section}${key ? `-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}` : ''}`;

export function HelpProvider({ children }: { children: ReactNode }) {
  const [sections, setSections] = useState<RefSection[]>([]);
  const [target, setTarget] = useState<{ section?: string; key?: string } | null>(null);
  useEffect(() => {
    api<{ sections: RefSection[] }>('/__sim/reference')
      .then((r) => setSections(r.sections))
      .catch(() => {});
  }, []);
  const value = useMemo<HelpApi>(() => {
    const entry = (section: string, key: string) =>
      sections.find((s) => s.id === section)?.entries.find((e) => e.key === key);
    return {
      entry,
      tip: (section, key) => {
        const e = entry(section, key);
        return e ? plain(`${e.summary}${e.default ? ` Default: ${e.default}.` : ''}`) : undefined;
      },
      open: (section, key) => setTarget({ section, key }),
    };
  }, [sections]);
  return (
    <HelpContext.Provider value={value}>
      {children}
      {target && (
        <ReferencePanel sections={sections} target={target} onClose={() => setTarget(null)} />
      )}
    </HelpContext.Provider>
  );
}

/** A small "?" (keyboard reachable) that shows the entry's summary on hover and opens it in the Reference panel. */
export function Help({ section, k, label }: { section: string; k?: string; label?: string }) {
  const { tip, open, entry } = useHelp();
  const title = k ? tip(section, k) : 'Open this part of the scenario reference';
  if (k && !entry(section, k)) return null;
  return (
    // a span, not a <button>: inside a field's <label> a button would take the label
    // from the input it belongs to
    <span
      role="button"
      tabIndex={0}
      className="sim-help"
      title={title}
      aria-label={`About ${label ?? k ?? section}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open(section, k);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(section, k);
        }
      }}
    >
      ?
    </span>
  );
}

function ReferencePanel({
  sections,
  target,
  onClose,
}: {
  sections: RefSection[];
  target: { section?: string; key?: string };
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const hit = target.section ? anchor(target.section, target.key) : null;
  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  useEffect(() => {
    if (hit && !q) document.getElementById(hit)?.scrollIntoView({ block: 'start' });
  }, [hit, q, sections]);
  const needle = q.trim().toLowerCase();
  const shown = sections
    .map((s) => ({
      ...s,
      entries: needle
        ? s.entries.filter((e) =>
            [e.key, e.summary, e.detail ?? '', ...(e.uses ?? []), s.title]
              .join(' ')
              .toLowerCase()
              .includes(needle),
          )
        : s.entries,
    }))
    .filter((s) => s.entries.length);
  return (
    <aside
      className="sim-ref"
      role="dialog"
      aria-label="Scenario reference"
      data-testid="sim-reference"
    >
      <header className="sim-ref-h">
        <h2>Scenario reference</h2>
        <Button size="small" onClick={close}>
          Close
        </Button>
      </header>
      <input
        className="sim-ref-search"
        type="search"
        placeholder="Search: daily, latency, holidays…"
        aria-label="Search the reference"
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
      />
      <nav className="sim-ref-toc">
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${anchor(s.id)}`}
            onClick={(e) => {
              e.preventDefault();
              setQ('');
              document.getElementById(anchor(s.id))?.scrollIntoView({ block: 'start' });
            }}
          >
            {s.title}
          </a>
        ))}
      </nav>
      <div className="sim-ref-body" ref={body}>
        {shown.length === 0 && <p className="muted">Nothing matches "{q}".</p>}
        {shown.map((s) => (
          <section key={s.id} id={anchor(s.id)}>
            <h3>{s.title}</h3>
            {s.intro && <p className="muted">{md(s.intro)}</p>}
            <dl>
              {s.entries.map((e) => {
                const id = anchor(s.id, e.key);
                return (
                  <div key={e.key} id={id} className={id === hit ? 'sim-ref-hit' : undefined}>
                    <dt>
                      <code>{e.key}</code>
                      {e.default && <span className="muted"> · default {e.default}</span>}
                    </dt>
                    <dd>
                      {md(e.summary)}
                      {e.detail && <> {md(e.detail)}</>}
                      {e.uses && e.uses.length > 0 && (
                        <div className="muted">
                          {s.id === 'patterns' ? 'Settings: ' : 'For: '}
                          {e.uses.join(', ')}
                        </div>
                      )}
                      {e.example && <pre>{e.example}</pre>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
        <p className="muted">
          Also: <code>pnpm sim:help [topic]</code> in a terminal, and{' '}
          <code>docs/simulation-reference.md</code>.
        </p>
      </div>
    </aside>
  );
}
