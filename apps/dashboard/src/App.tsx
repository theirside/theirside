import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler, type Me } from './api';
import { Incident, Incidents } from './pages/Incidents';
import { Overview } from './pages/Overview';
import { Provider } from './pages/Provider';
import { Settings } from './pages/Settings';
import { href, useRoute } from './router';

function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="login">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          api('/v1/auth/login', { method: 'POST', body: { token } }).then(onLogin, () =>
            setError('That token is not valid.'),
          );
        }}
      >
        <h1>Theirside</h1>
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
        <button className="btn primary" type="submit">
          Sign in
        </button>
        <p className="muted">Self-hosted login uses the collector's THEIRSIDE_ADMIN_TOKEN.</p>
      </form>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [environment, setEnvironment] = useState(() => localStorage.getItem('im.env') ?? '');
  const [envs, setEnvs] = useState<string[]>([]);
  const route = useRoute();

  const loadMe = () => api<Me>('/v1/me').then(setMe, () => setMe(null));
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void loadMe();
  }, []);
  useEffect(() => {
    if (me)
      void api<{ environments: string[] }>('/v1/admin/overview').then(
        (o) => setEnvs(o.environments),
        () => {},
      );
  }, [me]);

  if (me === undefined) return null;
  if (me === null) return <Login onLogin={() => void loadMe()} />;

  const [section, arg] = route;
  let page;
  if (section === 'providers' && arg) page = <Provider name={arg} environment={environment} />;
  else if (section === 'incidents' && arg) page = <Incident id={arg} />;
  else if (section === 'incidents') page = <Incidents />;
  else if (section === 'settings') page = <Settings tab={arg ?? 'providers'} />;
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
          <span className="muted">{me.entitlements.plan}</span>
          <button
            className="btn"
            onClick={() => void api('/v1/auth/logout', { method: 'POST' }).then(() => setMe(null))}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>{page}</main>
    </div>
  );
}
