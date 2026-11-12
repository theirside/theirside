import { api, type ApiKey, type Me } from '../api';
import { Callout, Card, CopyButton, ErrorBox, usePoll } from '../components/ui';
import { href } from '../router';

const INSTALL = 'npm install @theirside/sdk';

/** The init() call with this collector's URL and, when we have it, the project key filled in. */
export function initSnippet(apiKey: string, endpoint: string): string {
  return `import { init } from '@theirside/sdk';\n\ninit({ apiKey: '${apiKey}', endpoint: '${endpoint}' });`;
}

/** AWS Lambda: wrap() records webhook invocations; inbound: true so a cold start doesn't wait. */
export function lambdaSnippet(apiKey: string, endpoint: string): string {
  return `import { init, wrap } from '@theirside/sdk';\n\ninit({ apiKey: '${apiKey}', endpoint: '${endpoint}', inbound: true });\n\nexport const handler = wrap(async (event) => {\n  // verify the signature and handle the event as usual\n  return { statusCode: 200, body: '' };\n});`;
}

const DECLARED_ROUTES = `webhooks: [\n  { path: '/webhooks/adyen', provider: 'Adyen' },\n  { path: '/webhooks/:tenant/clerk', provider: 'Clerk' },\n],`;

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
  const lambda = lambdaSnippet(key ?? 'tsd_live_…', endpoint);
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
      <Card
        title="3. Webhooks you receive (optional)"
        actions={<CopyButton text={lambda} label="Copy Lambda code" />}
      >
        <p className="muted">
          Webhooks from Stripe, GitHub, Shopify, Slack, Svix and other known senders are monitored
          with no extra code: on a Node server, <code>init</code> above is enough (collector 0.4.0
          or later). Only the route, your status, timing and the sender&apos;s timestamp are
          recorded; your other incoming traffic is ignored.
        </p>
        <p className="muted">
          <strong>AWS Lambda</strong> (API Gateway, ALB, function URLs): wrap the handler and add{' '}
          <code>inbound: true</code>, so a cold start sends its deliveries without waiting.
        </p>
        <pre className="summary" data-testid="connect-lambda">
          {lambda}
        </pre>
        <p className="muted">
          <strong>Declare the route</strong> for senders that headers can&apos;t identify: Adyen and
          Mailgun sign inside the body, and Clerk, Resend and other Svix customers all show as
          &quot;Svix&quot; until you name them. Add this to <code>init</code>:
        </p>
        <pre className="summary">{DECLARED_ROUTES}</pre>
        <p className="muted">
          Not covered yet: Google Cloud Functions, Azure Functions, Vercel, Netlify and Cloudflare
          Workers record outgoing calls only.
        </p>
      </Card>
      <p>
        <a href={href()}>Go to the dashboard</a>
      </p>
    </>
  );
}
