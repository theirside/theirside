import { useState } from 'react';
import { api, type LinkResult, type Me, type PendingInvite, type UserRow } from '../api';
import { Card, CopyButton, ErrorBox, usePoll } from '../components/ui';
import { ago, when } from '../format';

interface UsersData {
  users: UserRow[];
  invites: PendingInvite[];
  emailEnabled: boolean;
  you: string;
}

interface Security {
  require2fa: boolean;
  secretKeyConfigured: boolean;
  passwordUsersWithout2fa: number;
}

/** A one-time link to hand over: copy it, and whether it was emailed. */
function LinkCard({
  title,
  link,
  onClose,
}: {
  title: string;
  link: LinkResult;
  onClose: () => void;
}) {
  return (
    <Card title={title} actions={<CopyButton text={link.url} label="Copy link" />}>
      <pre className="summary" data-testid="one-time-link">
        {link.url}
      </pre>
      <p className="muted">
        Works once, until {when(link.expiresAt)}.{' '}
        {link.emailed
          ? 'It was also emailed.'
          : link.emailError
            ? `The email could not be sent (${link.emailError}); send the link yourself.`
            : 'Send it over a channel you trust.'}
      </p>
      <button className="btn" onClick={onClose}>
        Done
      </button>
    </Card>
  );
}

interface StepUp {
  password?: string;
  code?: string;
  adminToken?: string;
}

/**
 * Changes to someone else's account ask who you are again: your password (and a
 * 2FA code when yours is on), or the admin token in a break-glass session. Identity
 * proxy users are re-checked by their identity provider, so they only confirm.
 */
function StepUpForm({
  me,
  question,
  onConfirm,
  onCancel,
}: {
  me: Me;
  question: string;
  onConfirm: (s: StepUp) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState<StepUp>({});
  const field = (key: keyof StepUp, label: string, props: Record<string, unknown>) => (
    <label>
      {label}
      <input
        value={s[key] ?? ''}
        onChange={(e) => setS({ ...s, [key]: e.target.value })}
        name={`step-up-${key}`}
        {...props}
      />
    </label>
  );
  return (
    <Card title="Confirm it's you">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(s);
        }}
      >
        <p className="wide">{question}</p>
        {me.via === 'proxy' ? null : me.breakGlass ? (
          field('adminToken', 'Admin token', { type: 'password', autoFocus: true })
        ) : (
          <>
            {field('password', 'Your password', {
              type: 'password',
              autoFocus: true,
              autoComplete: 'current-password',
            })}
            {me.twoFactor.enabled &&
              field('code', 'Code from your authenticator app', {
                inputMode: 'numeric',
                autoComplete: 'one-time-code',
              })}
          </>
        )}
        <div className="wide row">
          <button className="btn primary" type="submit">
            Confirm
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

function SecurityCard() {
  const [data, error, reload] = usePoll(
    () => api<Security>('/v1/admin/settings/security'),
    [],
    60_000,
  );
  const [msg, setMsg] = useState('');
  if (!data) return <ErrorBox error={error} />;
  const set = (require2fa: boolean) => {
    setMsg('');
    api('/v1/admin/settings/security', { method: 'PUT', body: { require2fa } }).then(reload, (e) =>
      setMsg((e as Error).message),
    );
  };
  return (
    <Card title="Security">
      <label className="check">
        <input
          type="checkbox"
          checked={data.require2fa}
          disabled={!data.secretKeyConfigured && !data.require2fa}
          onChange={(e) => set(e.target.checked)}
        />{' '}
        Require two-factor sign-in for everyone
      </label>
      <p className="muted">
        {data.secretKeyConfigured
          ? `Users without it (${data.passwordUsersWithout2fa} now) must set it up before they can do anything else, including on sessions that are already open. Sign-ins through an identity proxy rely on its own MFA.`
          : 'Needs THEIRSIDE_SECRET_KEY on the collector, which encrypts the authenticator secrets.'}
      </p>
      {msg && <div className="error">{msg}</div>}
    </Card>
  );
}

export function UsersTab({ me }: { me: Me }) {
  const [data, error, reload] = usePoll(() => api<UsersData>('/v1/admin/users'), [], 30_000);
  const [email, setEmail] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [link, setLink] = useState<{ title: string; link: LinkResult } | null>(null);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState('');
  const [pending, setPending] = useState<{
    question: string;
    act: (stepUp: StepUp) => Promise<unknown>;
  } | null>(null);

  const run = (p: Promise<unknown>) => {
    setMsg('');
    setDone('');
    p.then(reload, (e) => setMsg((e as Error).message));
  };
  /** An action on someone else's account: step-up first, and say whether they were emailed. */
  const stepUp = (question: string, act: (stepUp: StepUp) => Promise<unknown>) => {
    setMsg('');
    setDone('');
    setLink(null);
    setPending({ question, act });
  };
  const inviteUser = () =>
    run(
      api<LinkResult & { email: string }>('/v1/admin/users/invites', {
        method: 'POST',
        body: { email: email.trim(), sendEmail: data?.emailEnabled ? sendEmail : false },
      }).then((r) => {
        setLink({ title: `Invite for ${r.email}`, link: r });
        setEmail('');
      }),
    );
  const resetLink = (u: UserRow) =>
    stepUp(`Make a password reset link for ${u.email ?? u.name}?`, (s) =>
      api<LinkResult>(`/v1/admin/users/${u.id}/reset-link`, {
        method: 'POST',
        body: { sendEmail: !!data?.emailEnabled && sendEmail, stepUp: s },
      }).then((r) => setLink({ title: `Password reset for ${u.email ?? u.name}`, link: r })),
    );
  const confirmThen = (question: string, p: () => Promise<unknown>) => {
    if (confirm(question)) run(p());
  };

  return (
    <>
      <ErrorBox error={error} />
      <p className="muted">
        Everyone here can do everything, including managing users. Roles, SSO and an audit log are
        part of the paid editions.
      </p>
      {pending && (
        <StepUpForm
          me={me}
          question={pending.question}
          onCancel={() => setPending(null)}
          onConfirm={(s) => {
            const act = pending.act;
            setMsg('');
            // the form stays open on a wrong password or code
            act(s).then(
              (r) => {
                setPending(null);
                if ((r as { notified?: boolean } | undefined)?.notified)
                  setDone('Done. They were emailed about it.');
                reload();
              },
              (e) => setMsg((e as Error).message),
            );
          }}
        />
      )}
      {link && <LinkCard title={link.title} link={link.link} onClose={() => setLink(null)} />}
      {msg && <div className="error">{msg}</div>}
      {done && <div className="ok">{done}</div>}
      <Card title="Invite someone">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            inviteUser();
          }}
        >
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              name="invite-email"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!!data?.emailEnabled && sendEmail}
              disabled={!data?.emailEnabled}
              onChange={(e) => setSendEmail(e.target.checked)}
            />
            {data?.emailEnabled
              ? 'Also email the links (invites and resets)'
              : 'Email is off (no SMTP): copy the link instead'}
          </label>
          <div className="wide">
            <button className="btn primary" type="submit">
              Create invite link
            </button>{' '}
            <span className="muted">Links work once and expire after 7 days.</span>
          </div>
        </form>
      </Card>
      <Card title="Users">
        <table className="table" data-testid="users">
          <thead>
            <tr>
              <th>User</th>
              <th>Sign-in</th>
              <th>Last sign-in</th>
              <th>Sessions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.name}</b>
                  {u.id === data.you && <span className="tag">you</span>}
                  <div className="muted">{u.email}</div>
                </td>
                <td>
                  <span className="tag">
                    {u.source === 'proxy' ? 'identity proxy' : 'password'}
                  </span>
                  {u.twoFactor && <span className="tag new">2FA</span>}
                  {u.source === 'password' && !u.hasPassword && (
                    <span className="tag">no password yet</span>
                  )}
                </td>
                <td className="muted">{u.lastLoginAt ? ago(u.lastLoginAt) : 'never'}</td>
                <td className="muted">{u.activeSessions}</td>
                <td className="actions">
                  {u.source === 'password' && (
                    <button className="btn small" onClick={() => resetLink(u)}>
                      Reset link
                    </button>
                  )}
                  {u.twoFactor && (
                    <button
                      className="btn small"
                      onClick={() =>
                        stepUp(
                          `Turn off two-factor sign-in for ${u.email}? Do this when they lost their phone; they can set it up again.`,
                          (s) =>
                            api(`/v1/admin/users/${u.id}/disable-2fa`, {
                              method: 'POST',
                              body: { stepUp: s },
                            }),
                        )
                      }
                    >
                      Turn off 2FA
                    </button>
                  )}
                  {u.activeSessions > 0 && (
                    <button
                      className="btn small"
                      onClick={() =>
                        confirmThen(`Sign ${u.email ?? u.name} out on every device?`, () =>
                          api(`/v1/admin/users/${u.id}/sign-out`, { method: 'POST' }),
                        )
                      }
                    >
                      Sign out
                    </button>
                  )}
                  {u.id !== data.you && (
                    <button
                      className="btn small danger"
                      onClick={() =>
                        stepUp(`Remove ${u.email ?? u.name}? They lose access at once.`, (s) =>
                          api(`/v1/admin/users/${u.id}`, { method: 'DELETE', body: { stepUp: s } }),
                        )
                      }
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!!data?.invites.length && (
          <>
            <h3>Pending invites</h3>
            <table className="table" data-testid="invites">
              <tbody>
                {data.invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td className="muted">expires {when(i.expiresAt)}</td>
                    <td className="actions">
                      <button
                        className="btn small danger"
                        onClick={() =>
                          run(api(`/v1/admin/users/invites/${i.id}`, { method: 'DELETE' }))
                        }
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
      <SecurityCard />
    </>
  );
}
