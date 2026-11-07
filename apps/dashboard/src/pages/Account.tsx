import { useState } from 'react';
import { api, type Me, type TwoFactorStatus } from '../api';
import { RecoveryCodes, TwoFactorSetup } from '../components/TwoFactor';
import { Badge, Button, Callout, Card, ErrorBox, Field, usePoll } from '../components/ui';

function PasswordCard() {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = () => {
    if (form.next.length < 12) return setMsg({ ok: false, text: 'Use at least 12 characters.' });
    if (form.next !== form.confirm) return setMsg({ ok: false, text: 'The two passwords differ.' });
    api('/v1/account/password', {
      method: 'POST',
      body: { currentPassword: form.current, newPassword: form.next },
    }).then(
      () => {
        setForm({ current: '', next: '', confirm: '' });
        setMsg({ ok: true, text: 'Password changed. Your other sessions were signed out.' });
      },
      (e) => setMsg({ ok: false, text: (e as Error).message }),
    );
  };
  return (
    <Card title="Password">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field wide>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={form.current}
            onChange={(e) => setForm({ ...form, current: e.target.value })}
          />
        </Field>
        <Field>
          New password <small>at least 12 characters</small>
          <input
            type="password"
            autoComplete="new-password"
            value={form.next}
            onChange={(e) => setForm({ ...form, next: e.target.value })}
          />
        </Field>
        <Field>
          Repeat new password
          <input
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          />
        </Field>
        <div className="wide row">
          <Button variant="primary" type="submit">
            Change password
          </Button>
          {msg && <span className={msg.ok ? 'ok' : 'error'}>{msg.text}</span>}
        </div>
      </form>
    </Card>
  );
}

/** Asks for the password (masked) before a sensitive 2FA change. */
function ConfirmWithPassword({
  question,
  onConfirm,
  onCancel,
}: {
  question: string;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) onConfirm(password);
      }}
    >
      <span>{question}</span>
      <input
        type="password"
        autoFocus
        autoComplete="current-password"
        placeholder="Your password"
        aria-label="Your password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button variant="primary" type="submit">
        Confirm
      </Button>
      <Button type="button" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function TwoFactorCard() {
  const [status, error, reload] = usePoll(
    () => api<TwoFactorStatus>('/v1/account/2fa'),
    [],
    60_000,
  );
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState<{ path: string; question: string } | null>(null);
  const [msg, setMsg] = useState('');
  if (!status) return <ErrorBox error={error} />;

  const act = (path: string, question: string) => {
    setMsg('');
    setPending({ path, question });
  };
  const confirmed = (password: string) => {
    const path = pending!.path;
    setPending(null);
    api<{ recoveryCodes?: string[] }>(path, { method: 'POST', body: { password } }).then(
      (r) => {
        if (r.recoveryCodes) setCodes(r.recoveryCodes);
        reload();
      },
      (e) => setMsg((e as Error).message),
    );
  };

  return (
    <Card title="Two-factor sign-in">
      {codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : status.enabled ? (
        <div className="stack">
          <p>
            <Badge tone="healthy">On</Badge> Sign-in asks for a code from your authenticator app.{' '}
            {status.recoveryCodesLeft} recovery code
            {status.recoveryCodesLeft === 1 ? '' : 's'} left.
          </p>
          {status.recoveryCodesLeft <= 3 && (
            <Callout tone="danger">Few recovery codes left: make new ones.</Callout>
          )}
          {pending ? (
            <ConfirmWithPassword
              question={pending.question}
              onConfirm={confirmed}
              onCancel={() => setPending(null)}
            />
          ) : (
            <div className="row">
              <Button
                type="button"
                onClick={() =>
                  act(
                    '/v1/account/2fa/recovery-codes',
                    'Make new recovery codes? The old ones stop working.',
                  )
                }
              >
                New recovery codes
              </Button>
              {status.required ? (
                <span className="muted">
                  Required for everyone here, so it can't be turned off.
                </span>
              ) : (
                <Button
                  variant="danger"
                  type="button"
                  onClick={() => act('/v1/account/2fa/disable', 'Turn off two-factor sign-in?')}
                >
                  Turn off
                </Button>
              )}
            </div>
          )}
        </div>
      ) : status.available ? (
        <TwoFactorSetup onDone={reload} />
      ) : (
        <Callout>
          Two-factor sign-in needs THEIRSIDE_SECRET_KEY on the collector (it encrypts the
          authenticator secrets). Ask whoever runs Theirside to set one.
        </Callout>
      )}
      {msg && <div className="error">{msg}</div>}
    </Card>
  );
}

export function Account({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [msg, setMsg] = useState('');
  return (
    <>
      <div className="page-h">
        <h1>Your account</h1>
      </div>
      {me.breakGlass ? (
        <Callout>
          You are signed in with the collector's admin token (break-glass). It has no account
          settings; use it to fix accounts under Settings → Users, then sign in with an account.
        </Callout>
      ) : (
        <>
          <Card title="Profile">
            <p>
              <b>{me.user?.name}</b> · {me.user?.email} <Badge>{me.role}</Badge>
            </p>
            {me.role === 'member' && (
              <p className="muted">
                As a member you see everything and manage providers; an admin manages users, API
                keys, alert channels, status pages and security settings.
              </p>
            )}
            {me.via === 'proxy' && (
              <p className="muted">
                You sign in through your organization's identity proxy; your password and two-factor
                sign-in are managed there.
              </p>
            )}
          </Card>
          {me.via !== 'proxy' && (
            <>
              <PasswordCard />
              <TwoFactorCard />
              <Card title="Sessions">
                <p className="muted">
                  Signed in on a shared or lost device? Sign out everywhere, including here.
                </p>
                <Button
                  variant="danger"
                  type="button"
                  onClick={() => {
                    if (!confirm('Sign out on every device, including this one?')) return;
                    api('/v1/account/sign-out-everywhere', { method: 'POST' }).then(
                      onSignedOut,
                      (e) => setMsg((e as Error).message),
                    );
                  }}
                >
                  Sign out everywhere
                </Button>
                {msg && <div className="error">{msg}</div>}
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}
