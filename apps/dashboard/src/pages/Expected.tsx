/**
 * Expected outcomes from the dashboard (docs/scoring.md "Expected outcomes"): mark a
 * status as a normal answer for one endpoint ("Mark 400 as expected"), or take the
 * mark off. Used on the incident page, the endpoint rows and provider settings.
 * Members and admins may do it.
 */
import { useState } from 'react';
import { api } from '../api';
import { Badge, Button, Callout, ErrorBox } from '../components/ui';

/** The statuses rollups count one by one: the only ones the dashboard can mark. */
export const EXPECTABLE_STATUSES = [400, 401, 403, 404, 409, 422] as const;

/**
 * Statuses an incident of this kind may be about, most common first. A behaviour change
 * (e.g. while an endpoint's per-status mix is still being learned) may be any of them.
 */
export const STATUSES_OF_KIND: Record<string, number[]> = {
  validation: [400, 422, 409],
  auth: [401, 403],
  not_found: [404],
  behaviour: [...EXPECTABLE_STATUSES],
};

export interface MarkResult {
  statuses: number[];
  resolvedIncidents: string[];
}

export function setExpected(
  provider: string,
  ep: { method: string; endpoint: string },
  status: number,
  expected: boolean,
): Promise<MarkResult> {
  return api<MarkResult>(`/v1/admin/providers/${encodeURIComponent(provider)}/expected`, {
    method: 'PUT',
    body: { method: ep.method, endpoint: ep.endpoint, status, expected },
  });
}

/** One line on what this does and why code is better. */
export function ExpectedNote() {
  return (
    <p className="muted expected-note">
      Every call of this endpoint with that status will count as successful. That is less precise
      than marking in code (<code>markExpected('reason')</code> in the SDK), which tags only the
      answers your code read as normal, so a provider that starts answering it to everything still
      alerts. Here a safety net opens an incident when the status takes over (above 80% of calls, or
      halfway from its normal share to every call if that is higher, for 10 minutes).
    </p>
  );
}

/**
 * "Mark 400 as expected" for one endpoint: the statuses to choose from (the incident's
 * ones, or all markable ones), the note, and a confirm button.
 */
export function MarkExpected({
  provider,
  ep,
  statuses = [...EXPECTABLE_STATUSES],
  marked = [],
  onDone,
  autoFocus,
}: {
  provider: string;
  ep: { method: string; endpoint: string };
  statuses?: number[];
  marked?: number[];
  onDone?: (r: MarkResult) => void;
  autoFocus?: boolean;
}) {
  const choices = statuses.filter((s) => !marked.includes(s));
  const [status, setStatus] = useState<number>(choices[0] ?? statuses[0] ?? 400);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<MarkResult | null>(null);
  if (choices.length === 0 && !done) return null;
  return (
    <div className="mark-expected" data-testid="mark-expected">
      <ErrorBox error={error} />
      {done ? (
        <Callout tone="info" data-testid="mark-expected-done">
          {status} is now an expected answer for{' '}
          <code>
            {ep.method} {ep.endpoint}
          </code>
          {done.resolvedIncidents.length > 0 ? '; the open incident was resolved.' : '.'}
        </Callout>
      ) : (
        <form
          className="mark-expected-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setExpected(provider, ep, status, true).then(
              (r) => {
                setBusy(false);
                setDone(r);
                onDone?.(r);
              },
              (err: unknown) => {
                setBusy(false);
                setError(err);
              },
            );
          }}
        >
          {choices.length > 1 ? (
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(Number(e.target.value))}
            >
              {choices.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : null}
          <Button type="submit" disabled={busy} autoFocus={autoFocus}>
            Mark {choices.length === 1 ? choices[0] : status} as expected for{' '}
            {`${ep.method} ${ep.endpoint}`}
          </Button>
          <ExpectedNote />
        </form>
      )}
    </div>
  );
}

/** The statuses marked for an endpoint, each with an "unmark" control. */
export function ExpectedMarks({
  provider,
  ep,
  statuses,
  onChange,
}: {
  provider: string;
  ep: { method: string; endpoint: string };
  statuses: number[];
  onChange?: (statuses: number[]) => void;
}) {
  const [error, setError] = useState<unknown>(null);
  if (statuses.length === 0) return null;
  return (
    <span className="expected-marks">
      <ErrorBox error={error} />
      {statuses.map((s) => (
        <span key={s} className="expected-mark">
          <Badge tone="info" title="Marked expected from the dashboard: counted as successful">
            {s} expected
          </Badge>
          <Button
            type="button"
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              setExpected(provider, ep, s, false).then(
                (r) => onChange?.(r.statuses),
                (err: unknown) => setError(err),
              );
            }}
          >
            Unmark
          </Button>
        </span>
      ))}
    </span>
  );
}
