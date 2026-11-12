import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler, type AuthStatus, type Me } from './api';
import { Account } from './pages/Account';
import { Connect } from './pages/Connect';
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
import { SimBanner, Simulation, type SimClockView } from './pages/Simulation';
import { setNowSource } from './format';
import { Webhooks } from './pages/Webhooks';
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
  const [simClock, setSimClock] = useState<SimClockView | null>(null);

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
        (o) => {
          setEnvs(o.environments);
          // a remembered environment with no data (another install, or it went away) would leave
          // the dashboard empty with the picker hidden: fall back to all environments
          setEnvironment((cur) => {
            if (!cur || o.environments.includes(cur)) return cur;
            localStorage.removeItem('im.env');
            return '';
          });
        },
        () => {},
      );
  }, [me]);

  // simulation mode: the simulated clock for the banner and for relative times ("3 min ago")
  useEffect(() => {
    if (!me || !status?.simulation) return;
    let alive = true;
    const run = () =>
      void api<SimClockView>('/__sim/clock').then(
        (c) => {
          if (!alive) return;
          setSimClock(c);
          const at = Date.parse(c.now);
          setNowSource(() => at);
        },
        () => {},
      );
    run();
    const t = setInterval(run, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [me, status?.simulation]);

  const [section, arg] = route;
  // one-time links work whether or not someone is signed in on this browser
  if (section === 'invite' && arg) return <AcceptInvite token={arg} onDone={signedIn} />;
  if (section === 'reset' && arg) return <ResetPassword token={arg} />;
  if (me === undefined || status === undefined) return null;
  // the design gallery: open without sign-in when the collector enables it, absent otherwise
  if (section === 'design') return status.designGallery ? <DesignGallery /> : <NotFound />;
  if (me === null) {
    if (section === 'forgot') return <ForgotPassword />;
    if (status.setupRequired)
      return (
        <Setup
          status={status}
          {...(section === 'setup' && arg ? { token: arg } : {})}
          onDone={() => {
            // the first account goes on to connect an app (the project key, the SDK snippet)
            window.location.hash = href('connect');
            void loadMe();
          }}
        />
      );
    return <Login status={status} onDone={signedIn} />;
  }
  if (me.twoFactor.enrollmentRequired)
    return <EnrolTwoFactor me={me} onDone={() => void loadMe()} onSignOut={signOut} />;

  let page;
  if (section === 'providers' && arg) page = <Provider name={arg} environment={environment} />;
  else if (section === 'incidents' && arg) page = <Incident id={arg} />;
  else if (section === 'incidents') page = <Incidents />;
  else if (section === 'webhooks') page = <Webhooks environment={environment} />;
  else if (section === 'settings')
    page = <Settings tab={arg ?? 'providers'} {...(route[2] ? { sub: route[2] } : {})} me={me} />;
  else if (section === 'connect') page = <Connect me={me} />;
  else if (section === 'account') page = <Account me={me} onSignedOut={() => setMe(null)} />;
  else if (section === 'simulation' && status.simulation) page = <Simulation />;
  else page = <Overview environment={environment} />;

  const active = (s: string) =>
    (section ?? '') === s || (s === '' && section === 'providers') ? 'on' : '';
  return (
    <div className="app">
      {status.simulation && <SimBanner clock={simClock} />}
      <header className="top">
        <a className="brand" href={href()}>
          Theirside
        </a>
        <nav>
          <a href={href()} className={active('')}>
            Providers
          </a>
          <a href={href('webhooks')} className={active('webhooks')}>
            Webhooks
          </a>
          <a href={href('incidents')} className={active('incidents')}>
            Incidents
          </a>
          <a href={href('settings', 'providers')} className={active('settings')}>
            Settings
          </a>
          {status.simulation && (
            <a href={href('simulation')} className={active('simulation')}>
              Simulation
            </a>
          )}
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
