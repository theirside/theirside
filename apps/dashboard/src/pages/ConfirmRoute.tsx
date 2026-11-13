/**
 * Confirming a discovered webhook route (the Webhooks page and Settings → Providers):
 * link it to a provider the team already monitors, so outgoing calls and webhooks of
 * one company stay one provider, or create a new provider. The collector's best match
 * is preselected with the reason ("same domain as example.com").
 */
import { useMemo, useState } from 'react';
import { api, ApiError, type Provider, type WebhookCandidate } from '../api';
import { Button, ErrorBox, Field, usePoll } from '../components/ui';

/** "Lemon Squeezy" from "lemon-squeezy": a starting point for a new provider's name. */
export const titleCase = (s: string) =>
  s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const label = (p: Provider) => p.displayName || p.name;

/** Shown in the list: at most this many matches of the search. */
const SHOWN = 8;

export function ConfirmRoute({
  c,
  onDone,
  onCancel,
}: {
  c: WebhookCandidate;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [providers, loadError] = usePoll(
    () => api<{ providers: Provider[] }>('/v1/admin/providers'),
    [],
    60_000,
  );
  const match = c.match ?? null;
  const [mode, setMode] = useState<'link' | 'new'>(match?.kind === 'existing' ? 'link' : 'new');
  const [picked, setPicked] = useState<string | null>(
    match?.kind === 'existing' ? match.provider : null,
  );
  const [search, setSearch] = useState('');
  const [name, setName] = useState(
    match && match.kind !== 'existing'
      ? match.provider
      : c.suggestedName
        ? titleCase(c.suggestedName)
        : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const usable = useMemo(
    () =>
      (providers?.providers ?? [])
        .filter((p) => !p.hidden && !p.internal)
        .sort((a, b) => label(a).localeCompare(label(b))),
    [providers],
  );
  const q = search.trim().toLowerCase();
  const found = usable.filter(
    (p) =>
      !q ||
      label(p).toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      (p.domain ?? '').toLowerCase().includes(q),
  );
  // the picked provider stays visible whatever the search
  const shown = [
    ...found.slice(0, SHOWN),
    ...usable.filter((p) => p.name === picked && !found.slice(0, SHOWN).includes(p)),
  ];

  const submit = async () => {
    const provider = mode === 'link' ? picked : name.trim();
    if (!provider) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api('/v1/admin/webhooks/candidates/confirm', {
        method: 'PUT',
        body: { endpoint: c.endpoint, provider, mode },
      });
      onDone();
    } catch (err) {
      // a provider with that name exists: offer linking to it instead of a second one
      const existing =
        err instanceof ApiError && err.status === 409
          ? (err.body as { provider?: unknown } | undefined)?.provider
          : undefined;
      if (mode === 'new' && typeof existing === 'string') {
        setMode('link');
        setPicked(existing);
        setNote(`A provider with that name exists; link the route to it.`);
      } else setError(err);
    } finally {
      setBusy(false);
    }
  };

  const titleId = `confirm-${c.endpoint}`;
  return (
    <div
      className="confirm-route"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="confirm-route"
    >
      <h3 id={titleId}>
        Monitor <code>{`${c.method} ${c.endpoint}`}</code> as webhooks from…
      </h3>
      <ErrorBox error={loadError ?? error} />
      {note && <p className="muted">{note}</p>}
      <div className="confirm-route-modes">
        <Field check label="Link to an existing provider">
          <input
            type="radio"
            name={`mode-${c.endpoint}`}
            checked={mode === 'link'}
            onChange={() => setMode('link')}
          />
        </Field>
        <Field check label="Create new provider">
          <input
            type="radio"
            name={`mode-${c.endpoint}`}
            checked={mode === 'new'}
            onChange={() => setMode('new')}
          />
        </Field>
      </div>
      {mode === 'link' ? (
        <div className="confirm-route-link">
          <input
            aria-label="Search providers"
            placeholder="Search providers"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="confirm-route-list" aria-label="Providers">
            {shown.map((p) => (
              <li key={p.id}>
                <Field
                  check
                  label={
                    <>
                      {label(p)}
                      {p.domain && p.domain !== label(p) && (
                        <span className="muted"> {p.domain}</span>
                      )}
                      {match?.kind === 'existing' && match.provider === p.name && (
                        <span className="confirm-route-why"> suggested: {match.reason}</span>
                      )}
                    </>
                  }
                >
                  <input
                    type="radio"
                    name={`provider-${c.endpoint}`}
                    checked={picked === p.name}
                    onChange={() => setPicked(p.name)}
                  />
                </Field>
              </li>
            ))}
            {providers && shown.length === 0 && <li className="muted">No provider matches.</li>}
          </ul>
          {found.length > SHOWN && (
            <p className="muted">{found.length - SHOWN} more: narrow the search.</p>
          )}
        </div>
      ) : (
        <Field
          label="Provider name"
          hint={match && match.kind !== 'existing' ? `Suggested: ${match.reason}` : undefined}
        >
          <input
            value={name}
            maxLength={128}
            onChange={(e) => setName(e.target.value)}
            aria-label="New provider name"
          />
        </Field>
      )}
      <div className="row">
        <Button
          variant="primary"
          disabled={busy || (mode === 'link' ? !picked : !name.trim())}
          onClick={() => void submit()}
        >
          Confirm route
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
