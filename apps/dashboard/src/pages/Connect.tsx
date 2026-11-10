import { api, type ApiKey, type Me } from '../api';
import { Callout, Card, CopyButton, ErrorBox, usePoll } from '../components/ui';
import { href } from '../router';

const INSTALL = 'npm install @theirside/sdk';

/** The init() call with this collector's URL and, when we have it, the project key filled in. */
export function initSnippet(apiKey: string, endpoint: string): string {
  return `import { init } from '@theirside/sdk';\n\ninit({ apiKey: '${apiKey}', endpoint: '${endpoint}' });`;
}

/**
 * "Connect your app": shown right after the first account is created, and from Settings →
 * API keys. A zero-config first start generated the project key and admins can read it here;
 * otherwise the snippet has a placeholder and points at Settings → API keys.
 */
export function Connect({ me }: { me: Me }) {
  const admin = me.role === 'admin';
  const [data, error] = usePoll(() => api<{ apiKeys: ApiKey[] }>('/v1/admin/api-keys'), [], 60_000);
  const key = data?.apiKeys.find((k) => k.key && !k.revokedAt)?.key;
  const endpoint = window.location.origin;
  const snippet = initSnippet(key ?? 'tsd_live_…', endpoint);
  return (
    <>
      <div className="page-h">
        <h1>Connect your app</h1>
      </div>
      <ErrorBox error={error} />
      <p className="muted">
        Add the SDK to a Node.js service and every third-party API it calls shows up here within a
        minute. No provider list needed.
      </p>
      {data && key && (
        <Card title="Project API key" actions={<CopyButton text={key} label="Copy key" />}>
          <pre className="summary" data-testid="connect-api-key">
            {key}
          </pre>
          <p className="muted">
            Admins can see it again under{' '}
            <a href={href('settings', 'api-keys')}>Settings → API keys</a>. Treat it like a
            password: in production, pass it in an environment variable.
          </p>
        </Card>
      )}
      {data && !key && (
        <Callout>
          {admin ? (
            <>
              Create a key under <a href={href('settings', 'api-keys')}>Settings → API keys</a> and
              put it in place of <code>tsd_live_…</code> below.
            </>
          ) : (
            <>
              Ask an admin for a project API key and put it in place of <code>tsd_live_…</code>{' '}
              below.
            </>
          )}
        </Callout>
      )}
      <Card title="1. Install the SDK" actions={<CopyButton text={INSTALL} />}>
        <pre className="summary">{INSTALL}</pre>
      </Card>
      <Card
        title="2. Start it first thing in your app"
        actions={<CopyButton text={snippet} label="Copy code" />}
      >
        <pre className="summary" data-testid="connect-snippet">
          {snippet}
        </pre>
        <p className="muted">
          Call <code>init</code> once, before the modules that make HTTP calls are loaded. The
          endpoint is this collector as your browser reaches it; use the address your services reach
          it at if that differs.
        </p>
      </Card>
      <p>
        <a href={href()}>Go to the dashboard</a>
      </p>
    </>
  );
}
