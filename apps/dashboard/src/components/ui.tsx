import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { HealthStatus } from '../api';

const LABEL: Record<HealthStatus, string> = {
  green: 'Healthy',
  amber: 'Degraded',
  red: 'Failing',
  idle: 'Idle',
  unknown: 'No data',
};

export function StatusDot({ status, label = false }: { status: HealthStatus; label?: boolean }) {
  return (
    <span className="status">
      <span className={`dot ${status}`} aria-hidden />
      {label ? LABEL[status] : <span className="sr">{LABEL[status]}</span>}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o}
          role="tab"
          aria-selected={o === value}
          className={o === value ? 'on' : ''}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-h">
          <h2>{title}</h2>
          <div>{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error">{String((error as Error).message ?? error)}</div>;
}

/** Load data on mount and every `intervalMs`; returns [data, error, reload]. */
export function usePoll<T>(
  load: () => Promise<T>,
  deps: unknown[],
  intervalMs = 15_000,
): [T | undefined, unknown, () => void] {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () =>
      loadRef.current().then(
        (d) => alive && (setData(d), setError(undefined)),
        (e) => alive && setError(e),
      );
    void run();
    const t = setInterval(run, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [...deps, tick, intervalMs]);
  return [data, error, () => setTick((x) => x + 1)];
}
