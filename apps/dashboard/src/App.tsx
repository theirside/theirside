import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler, type AuthStatus, type Me } from './api';
import { Account } from './pages/Account';
import {
  AcceptInvite,
  EnrolTwoFactor,
  ForgotPassword,
  Login,
  ResetPassword,
  Setup,
} from './pages/Auth';
import { DesignGallery, NotFound } from './pages/DesignGallery';
import { Incident, Incidents } from './pages/Incidents';
import { Overview } from './pages/Overview';
import { Provider } from './pages/Provider';
import { Settings } from './pages/Settings';
import { AdminContext } from './role';
import { href, useRoute } from './router';
import { ThemeToggle } from './components/ThemeToggle';
import { Button } from './components/ui';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [environment, setEnvironment] = useState(() => localStorage.getItem('im.env') ?? '');
  const [envs, setEnvs] = useState<string[]>([]);
  const route = useRoute();

  const [status, setStatus] = useState<AuthStatus>();

  const loadMe = () => api<Me>('/v1/me').then(setMe, () => setMe(null));
  const loadStatus = () => api<AuthStatus>('/v1/auth/status').then(setStatus, () => {});
  const signedIn = () => {
    // leave one-time link pages for the dashboard
    if (/^#\/(invite|reset|forgot|setup)\b/.test(window.location.hash)) window.location.hash = '#/';
    void loadMe();
  };
  const signOut = () =>
    void api('/v1/auth/logout', { method: 'POST' }).then(() => {
      setMe(null);
      void loadStatus();
    });
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void loadStatus();
    void loadMe();
  }, []);
  useEffect(() => {
    if (me)
      void api<{ environments: string[] }>('/v1/admin/overview').then(
        (o) => setEnvs(o.environments),
        () => {},
      );
  }, [me]);

  const [section, arg] = route;
  // one-time links work whether or not someone is signed in on this browser
  if (section === 'invite' && arg) return <AcceptInvite token={arg} onDone={signedIn} />;
  if (section === 'reset' && arg) return <ResetPassword token={arg} />;
  if (me === undefined || status === undefined) return null;
  // the design gallery: open without sign-in when the collector enables it, absent otherwise
  if (section === 'design') return status.designGallery ? <DesignGallery /> : <NotFound />;
  if (me === null) {
    if (section === 'forgot') return <ForgotPassword />;
    if (status.setupRequired) return <Setup onDone={signedIn} />;
    return <Login status={status} onDone={signedIn} />;
  }
  if (me.twoFactor.enrollmentRequired)
    return <EnrolTwoFactor me={me} onDone={() => void loadMe()} onSignOut={signOut} />;

  let page;
  if (section === 'providers' && arg) page = <Provider name={arg} environment={environment} />;
  else if (section === 'incidents' && arg) page = <Incident id={arg} />;
  else if (section === 'incidents') page = <Incidents />;
  else if (section === 'settings')
    page = <Settings tab={arg ?? 'providers'} {...(route[2] ? { sub: route[2] } : {})} me={me} />;
  else if (section === 'account') page = <Account me={me} onSignedOut={() => setMe(null)} />;
  else page = <Overview environment={environment} />;

  const active = (s: string) =>
    (section ?? '') === s || (s === '' && section === 'providers') ? 'on' : '';
  return (
    <div className="app">
      <header className="top">
        <a className="brand" href={href()}>
          Theirside
        </a>
        <nav>
          <a href={href()} className={active('')}>
            Providers
          </a>
          <a href={href('incidents')} className={active('incidents')}>
            Incidents
          </a>
          <a href={href('settings', 'providers')} className={active('settings')}>
            Settings
          </a>
        </nav>
        <div className="right">
          {envs.length > 1 && (
            <select
              value={environment}
              onChange={(e) => {
                setEnvironment(e.target.value);
                localStorage.setItem('im.env', e.target.value);
              }}
              aria-label="Environment"
            >
              <option value="">All environments</option>
              {envs.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          )}
          <ThemeToggle />
          <span className="muted">{me.entitlements.plan}</span>
          <a href={href('account')} className={active('account')} data-testid="account-link">
            {me.breakGlass ? 'Admin token' : (me.user?.name ?? 'Account')}
          </a>
          {me.via !== 'proxy' && <Button onClick={signOut}>Sign out</Button>}
        </div>
      </header>
      <main>
        <AdminContext.Provider value={me.role === 'admin'}>{page}</AdminContext.Provider>
      </main>
    </div>
  );
}
