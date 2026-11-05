import { useEffect, useState, type ReactNode } from 'react';
import { api, type AuthStatus, type Me } from '../api';
import { TwoFactorSetup } from '../components/TwoFactor';
import { href } from '../router';

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
        <h1>Theirside</h1>
        <h2 className="login-sub">{title}</h2>
        {children}
      </form>
    </div>
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
      <label>
        Password{' '}
        <small className="muted">at least {MIN_PASSWORD} characters; a passphrase is fine</small>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          name="new-password"
        />
      </label>
      <label>
        Repeat password
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          name="confirm-password"
        />
      </label>
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
        <label>
          Code from your authenticator app, or a recovery code
          <input
            autoFocus
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            name="code"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy}>
          Verify
        </button>
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
        <label>
          Admin token
          <input
            type="password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            name="token"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy}>
          Sign in
        </button>
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
        <p className="notice">
          This collector also accepts sign-in through your organization's identity proxy. Open the
          dashboard through it to sign in with your company account.
        </p>
      )}
      <label>
        Email
        <input
          type="email"
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          name="email"
        />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          name="password"
        />
      </label>
      {error && <div className="error">{error}</div>}
      <button className="btn primary" type="submit" disabled={busy}>
        Sign in
      </button>
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
export function Setup({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  return (
    <Shell
      title="Create the first account"
      onSubmit={() => {
        const issue = passwordIssue(password, confirm);
        if (issue) return setError(issue);
        setError('');
        api('/v1/auth/setup', {
          method: 'POST',
          body: { setupCode: secret.trim(), adminToken: secret.trim(), name, email, password },
        }).then(onDone, (e) => setError(message(e)));
      }}
    >
      <p className="muted">
        Nobody can sign in yet. Enter the setup code from the collector's log (
        <code>docker compose logs collector | grep "setup code"</code>) or its
        THEIRSIDE_ADMIN_TOKEN.
      </p>
      <label>
        Setup code or admin token
        <input
          autoFocus
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          name="setup-code"
        />
      </label>
      <label>
        Your name
        <input
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          name="name"
        />
      </label>
      <label>
        Email
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          name="email"
        />
      </label>
      <NewPassword
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
      />
      {error && <div className="error">{error}</div>}
      <button className="btn primary" type="submit">
        Create account
      </button>
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
      <label>
        Your name
        <input
          autoFocus
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          name="name"
        />
      </label>
      <NewPassword
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
      />
      {error && <div className="error">{error}</div>}
      <button className="btn primary" type="submit">
        Create account
      </button>
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
      <button className="btn primary" type="submit">
        Set password
      </button>
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
          <label>
            Email
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              name="email"
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" type="submit">
            Send reset link
          </button>
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
        <h1>Theirside</h1>
        <h2 className="login-sub">Set up two-factor sign-in</h2>
        <p>
          Two-factor sign-in is required for everyone here. Set it up for{' '}
          <b>{me.user?.email ?? me.user?.name}</b> to continue.
        </p>
        <TwoFactorSetup onDone={onDone} />
        <button className="btn" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
