import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type TableHTMLAttributes,
} from 'react';
import type { HealthStatus } from '../api';

/**
 * Shared UI primitives (docs/design-system.md). Pages build from these and the
 * design tokens only; styles live in styles.css under the same class names.
 */

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

const LABEL: Record<HealthStatus, string> = {
  green: 'Healthy',
  amber: 'Degraded',
  red: 'Failing',
  receiving: 'Receiving',
  idle: 'Idle',
  unknown: 'No data',
};

/** A health status as a coloured dot, with its word visible (`label`) or for screen readers only. */
export function StatusDot({ status, label = false }: { status: HealthStatus; label?: boolean }) {
  return (
    <span className="status">
      <span className={`dot ${status}`} aria-hidden />
      {label ? LABEL[status] : <span className="sr">{LABEL[status]}</span>}
    </span>
  );
}

export type ButtonVariant = 'default' | 'primary' | 'danger';

/** A button. `type` stays the browser default (submit inside a form), as with `<button>`. */
export function Button({
  variant = 'default',
  size = 'default',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'default' | 'small';
}) {
  return (
    <button
      className={cx(
        'btn',
        variant !== 'default' && variant,
        size === 'small' && 'small',
        className,
      )}
      {...rest}
    />
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export type BadgeTone = 'neutral' | 'danger' | 'healthy' | 'warning' | 'info';

/** A short label: a state, a role, "new". With `href` it is a link (e.g. to an open incident). */
export function Badge({
  tone = 'neutral',
  href,
  children,
  className,
  ...rest
}: {
  tone?: BadgeTone | undefined;
  href?: string;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, 'children'>) {
  const cls = cx('tag', tone !== 'neutral' && tone, className);
  return href ? (
    <a href={href} className={cls} {...rest}>
      {children}
    </a>
  ) : (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}

/** A note in the flow of a page: `warning` (default) for caveats, `danger` for problems, `info` for hints. */
export function Callout({
  tone = 'warning',
  title,
  children,
  className,
  ...rest
}: {
  tone?: 'warning' | 'danger' | 'info';
  title?: ReactNode;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'>) {
  return (
    <div className={cx('callout', tone, className)} {...rest}>
      {title && <strong className="callout-title">{title}</strong>}
      {children}
    </div>
  );
}

/** A segmented switch between a few options (ranges, modes). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
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

export interface TabItem {
  id: string;
  label: ReactNode;
  /** A link tab (navigates); without it the tab is a button calling `onChange`. */
  href?: string;
}

/** Tabs along a bottom border: page sections (`href`) or in-page panels (`onChange`). */
export function Tabs({
  items,
  value,
  onChange,
  variant = 'page',
  label,
}: {
  items: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  variant?: 'page' | 'sub';
  label?: string;
}) {
  return (
    <nav
      className={cx('tabs', variant === 'sub' && 'subtabs')}
      role={onChange ? 'tablist' : undefined}
      aria-label={label}
    >
      {items.map((t) =>
        t.href ? (
          <a
            key={t.id}
            href={t.href}
            className={t.id === value ? 'on' : ''}
            aria-current={t.id === value ? 'page' : undefined}
          >
            {t.label}
          </a>
        ) : (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === value}
            className={t.id === value ? 'on' : ''}
            onClick={() => onChange?.(t.id)}
          >
            {t.label}
          </button>
        ),
      )}
    </nav>
  );
}

/** A section of a page: 24px padding, 16px between its header and its content. */
export function Card({
  title,
  actions,
  children,
  className,
  ...rest
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'>) {
  return (
    <section className={cx('card', className)} {...rest}>
      {(title || actions) && (
        <header className="card-h">
          <h2>{title}</h2>
          <div className="card-actions">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

/** A data table: header row, hairline rows, `num` cells right-aligned with tabular figures. */
export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cx('table', className)} {...rest} />;
}

/**
 * A form field: the label text (and an optional `hint`) above its control. Fields
 * in one row of a `.form` grid share a bottom edge; `check` puts a checkbox or
 * radio before its label, centred on the height of an input.
 */
export function Field({
  label,
  hint,
  wide,
  check,
  className,
  children,
  ...rest
}: {
  label?: ReactNode;
  hint?: ReactNode;
  wide?: boolean;
  check?: boolean;
  children: ReactNode;
} & LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cx('field', wide && 'wide', check && 'check', className)} {...rest}>
      {check ? (
        <>
          {children}
          {label}
          {hint && <small>{hint}</small>}
        </>
      ) : (
        <>
          {label}
          {hint && <small>{hint}</small>}
          {children}
        </>
      )}
    </label>
  );
}

/**
 * A chart legend entry that toggles its series: a box in the series colour,
 * filled with a dark tick while shown, outlined while hidden. The whole row is
 * the hit area.
 */
export function LegendCheckbox({
  label,
  color,
  checked,
  onChange,
  value,
  dashed,
}: {
  label: string;
  /** A CSS colour, normally `var(--chart-N)` or a semantic colour token. */
  color: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The value under the cursor, if any. */
  value?: ReactNode;
  dashed?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={cx('legend-item', !checked && 'off', dashed && 'dashed')}
      style={{ ['--series' as string]: color }}
      onClick={() => onChange(!checked)}
    >
      <span className="legend-box" aria-hidden>
        <svg viewBox="0 0 12 12" width="12" height="12">
          <path d="M2.5 6.2 5 8.6l4.5-5" />
        </svg>
      </span>
      <span className="legend-label">{label}</span>
      {value !== undefined && <span className="legend-value">{value}</span>}
    </button>
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
