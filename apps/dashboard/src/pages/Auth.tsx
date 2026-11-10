import { useEffect, useState, type ReactNode } from 'react';
import { api, type AuthStatus, type Me } from '../api';
import { TwoFactorSetup } from '../components/TwoFactor';
import { href } from '../router';
import { Badge, Button, Callout, Field, StatusDot } from '../components/ui';

const MIN_PASSWORD = 12;

function Shell({
  title,
  children,
  onSubmit,
}: {
  title: string;
  children: ReactNode;
  onSubmit?: () => void;
}) {
  return (
    <div className="login">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
      >
        <h1 className="login-sub">{title}</h1>
        {children}
      </form>
      <LoginPanel />
    </div>
  );
}

/** Brand panel beside every sign-in screen. The incident is a labelled sample, never tenant data. */
function LoginPanel() {
  return (
    <aside className="login-panel">
      <div className="login-brand">Theirside</div>
      <div className="login-pitch">
        <p className="login-statement">It&apos;s not you. It&apos;s them.</p>
        <p className="login-lead">
          Know within minutes when a provider&apos;s endpoint starts failing, and which one.
        </p>
      </div>
      <div className="login-sample">
        <div className="login-sample-label">Sample incident</div>
        <div className="login-sample-provider">
          <StatusDot status="red" />
          Acme Cards
          <Badge tone="danger">Failing</Badge>
        </div>
        <code>POST /v2/cards/:id/activate</code>
        <div>
          <b>38%</b> <span className="muted">errors for 6 min, normally 0.2%</span>
        </div>
        <div className="login-sample-chart">
          <svg
            viewBox="0 0 320 90"
            preserveAspectRatio="none"
            role="img"
            aria-label="Sample error rate holds near zero, then jumps above the incident threshold"
          >
            <line className="threshold" x1="0" y1="50" x2="320" y2="50" />
            <path className="rate" d="M0 84 H235 L248 14 H320" />
          </svg>
          <span>Incident threshold</span>
        </div>
        <div className="muted login-sample-ok">
          <StatusDot status="green" />
          Other Acme endpoints OK
        </div>
      </div>
    </aside>
  );
}

/** New password twice; returns the problem to show, or '' when it can be sent. */
function passwordIssue(password: string, confirm: string): string {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password !== confirm) return 'The two passwords differ.';
  return '';
}

function NewPassword({
  password,
  confirm,
  onPassword,
  onConfirm,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
}) {
  return (
    <>
      <Field>
        Password{' '}
        <small className="muted">at least {MIN_PASSWORD} characters; a passphrase is fine</small>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          name="new-password"
        />
      </Field>
      <Field>
        Repeat password
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          name="confirm-password"
        />
      </Field>
    </>
  );
}

const message = (e: unknown) => (e as Error).message;

export function Login({ status, onDone }: { status: AuthStatus; onDone: () => void }) {
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = (p: Promise<void>) => {
    setBusy(true);
    setError('');
    p.catch((e) => setError(message(e))).finally(() => setBusy(false));
  };

  if (mfaToken)
    return (
      <Shell
        title="Two-factor sign-in"
        onSubmit={() =>
          run(api('/v1/auth/login/2fa', { method: 'POST', body: { mfaToken, code } }).then(onDone))
        }
      >
        <Field>
          Code from your authenticator app, or a recovery code
          <input
            autoFocus
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            name="code"
          />
        </Field>
        {error && <div className="error">{error}</div>}
        <Button variant="primary" type="submit" disabled={busy}>
          Verify
        </Button>
        <a href={href()} onClick={() => setMfaToken(null)}>
          Back
        </a>
      </Shell>
    );

  if (mode === 'token')
    return (
      <Shell
        title="Sign in with the admin token"
        onSubmit={() =>
          run(api('/v1/auth/login', { method: 'POST', body: { token } }).then(onDone))
        }
      >
        <p className="muted">
          Break-glass access with the collector's THEIRSIDE_ADMIN_TOKEN, for when no account can
          sign in.
        </p>
        <Field>
          Admin token
          <input
            type="password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            name="token"
          />
        </Field>
        {error && <div className="error">{error}</div>}
        <Button variant="primary" type="submit" disabled={busy}>
          Sign in
        </Button>
        <a href={href()} onClick={() => setMode('password')}>
          Sign in with your account
        </a>
      </Shell>
    );

  return (
    <Shell
      title="Sign in"
      onSubmit={() =>
        run(
          api<{ mfaRequired?: boolean; mfaToken?: string }>('/v1/auth/login', {
            method: 'POST',
            body: { email, password },
          }).then((r) => {
            if (r.mfaRequired && r.mfaToken) setMfaToken(r.mfaToken);
            else onDone();
          }),
        )
      }
    >
      {status.proxy && (
        <Callout>
          This collector also accepts sign-in through your organization's identity proxy. Open the
          dashboard through it to sign in with your company account.
        </Callout>
      )}
      <Field>
        Email
        <input
          type="email"
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          name="email"
        />
      </Field>
      <Field>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          name="password"
        />
      </Field>
      {error && <div className="error">{error}</div>}
      <Button variant="primary" type="submit" disabled={busy}>
        Sign in
      </Button>
      <div className="login-links">
        {status.emailEnabled ? (
          <a href={href('forgot')}>Forgot password?</a>
        ) : (
          <span className="muted">Forgot your password? Ask another user for a reset link.</span>
        )}
        {status.adminTokenEnabled && (
          <a
            href={href()}
            onClick={(e) => {
              e.preventDefault();
              setMode('token');
            }}
          >
            Use the admin token
          </a>
        )}
      </div>
    </Shell>
  );
}

/** First run: create the first account, with the setup code from the log or the admin token. */
/** The token from a pasted setup link (…/setup?token=… or …/#/setup/…), or the token itself. */
function setupToken(raw: string): string {
  const v = raw.trim();
  return /[?&]token=([A-Za-z0-9]+)/.exec(v)?.[1] ?? /#\/setup\/([A-Za-z0-9]+)/.exec(v)?.[1] ?? v;
}

export function Setup({
  status,
  token,
  onDone,
}: {
  status: AuthStatus;
  /** From the setup link (#/setup/<token>). */
  token?: string;
  onDone: () => void;
}) {
  const mode = status.setup ?? 'code';
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const fromLink = mode === 'link' && !!token;
  const credentials =
    mode === 'code'
      ? { setupCode: secret.trim(), adminToken: secret.trim() }
      : mode === 'link'
        ? { setupCode: token ?? setupToken(secret) }
        : {};
  return (
    <Shell
      title="Create the first account"
      onSubmit={() => {
        const issue = passwordIssue(password, confirm);
        if (issue) return setError(issue);
        setError('');
        api('/v1/auth/setup', {
          method: 'POST',
          body: { ...credentials, name, email, password },
        }).then(onDone, (e) => setError(message(e)));
      }}
    >
      {mode === 'code' && (
        <>
          <p className="muted">
            Nobody can sign in yet. Enter the setup code from the collector&apos;s log (
            <code>docker compose logs collector | grep &quot;setup code&quot;</code>) or its
            THEIRSIDE_ADMIN_TOKEN.
          </p>
          <Field>
            Setup code or admin token
            <input
              autoFocus
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              name="setup-code"
            />
          </Field>
        </>
      )}
      {mode === 'link' && !fromLink && (
        <>
          <p className="muted">
            Nobody can sign in yet. Open the setup link from the collector&apos;s log (
            <code>docker compose logs collector | grep setup</code>), or paste it here.
          </p>
          <Field>
            Setup link
            <input
              autoFocus
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              name="setup-link"
            />
          </Field>
        </>
      )}
      {(fromLink || mode === 'open') && (
        <p className="muted">
          Nobody can sign in yet. This account will be the first admin; it can invite everyone else.
        </p>
      )}
      <Field>
        Your name
        <input
          autoFocus={fromLink || mode === 'open'}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          name="name"
        />
      </Field>
      <Field>
        Email
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          name="email"
        />
      </Field>
      <NewPassword
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
      />
      {error && <div className="error">{error}</div>}
      <Button variant="primary" type="submit">
        Create account
      </Button>
    </Shell>
  );
}

/** One-time link pages load their details first so an expired link says so straight away. */
function useLinkInfo(path: string, token: string) {
  const [info, setInfo] = useState<{ email: string | null; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ email: string | null; expiresAt: string }>(path, {
      method: 'POST',
      body: { token },
    }).then(setInfo, (e) => setError(message(e)));
  }, [path, token]);
  return { info, error };
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const { info, error: linkError } = useLinkInfo('/v1/auth/invite/info', token);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  if (linkError)
    return (
      <Shell title="Invitation">
        <div className="error">{linkError}</div>
        <a href={href()}>Go to sign-in</a>
      </Shell>
    );
  if (!info) return null;
  return (
    <Shell
      title="Create your account"
      onSubmit={() => {
        const issue = passwordIssue(password, confirm);
        if (issue) return setError(issue);
        api('/v1/auth/invite/accept', { method: 'POST', body: { token, name, password } }).then(
          onDone,
          (e) => setError(message(e)),
        );
      }}
    >
      <p>
        You were invited as <b>{info.email}</b>.
      </p>
      <Field>
        Your name
        <input
          autoFocus
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          name="name"
        />
      </Field>
      <NewPassword
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
      />
      {error && <div className="error">{error}</div>}
      <Button variant="primary" type="submit">
        Create account
      </Button>
    </Shell>
  );
}

export function ResetPassword({ token }: { token: string }) {
  const { info, error: linkError } = useLinkInfo('/v1/auth/password-reset/info', token);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  if (linkError || done)
    return (
      <Shell title="Reset password">
        {done ? (
          <p>Your password was changed and you were signed out everywhere.</p>
        ) : (
          <div className="error">{linkError}</div>
        )}
        <a href={href()}>Go to sign-in</a>
      </Shell>
    );
  if (!info) return null;
  return (
    <Shell
      title="Choose a new password"
      onSubmit={() => {
        const issue = passwordIssue(password, confirm);
        if (issue) return setError(issue);
        api('/v1/auth/password-reset', { method: 'POST', body: { token, password } }).then(
          () => setDone(true),
          (e) => setError(message(e)),
        );
      }}
    >
      {info.email && (
        <p>
          For <b>{info.email}</b>.
        </p>
      )}
      <NewPassword
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
      />
      {error && <div className="error">{error}</div>}
      <Button variant="primary" type="submit">
        Set password
      </Button>
    </Shell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  return (
    <Shell
      title="Forgot password"
      onSubmit={() =>
        api('/v1/auth/password-reset/request', { method: 'POST', body: { email } }).then(
          () => setSent(true),
          (e) => setError(message(e)),
        )
      }
    >
      {sent ? (
        <p>If {email} has an account, a reset link is on its way. It works for 1 hour.</p>
      ) : (
        <>
          <Field>
            Email
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              name="email"
            />
          </Field>
          {error && <div className="error">{error}</div>}
          <Button variant="primary" type="submit">
            Send reset link
          </Button>
        </>
      )}
      <a href={href()}>Back to sign-in</a>
    </Shell>
  );
}

/** The org requires 2FA and this account has none: set it up before anything else. */
export function EnrolTwoFactor({
  me,
  onDone,
  onSignOut,
}: {
  me: Me;
  onDone: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="login">
      <div className="login-card">
        <h1 className="login-sub">Set up two-factor sign-in</h1>
        <p>
          Two-factor sign-in is required for everyone here. Set it up for{' '}
          <b>{me.user?.email ?? me.user?.name}</b> to continue.
        </p>
        <TwoFactorSetup onDone={onDone} />
        <Button type="button" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
      <LoginPanel />
    </div>
  );
}
