# Adding Theirside to a NestJS service

This guide covers an existing NestJS backend that calls third-party providers through `@nestjs/axios` (`HttpService`) and/or `fetch`, possibly with AWS X-Ray and Sentry enabled. The SDK needs no changes to your services or modules: a few lines at the top of `main.ts`, one shutdown hook, and three env vars. A working example is `examples/nestjs-demo`.

What the SDK records and what it never records: [privacy.md](privacy.md). Share that file with whoever approves this for the project.

## Rollout checklist

Tick every line before the SDK goes into a production service.

- [ ] **Client OK obtained in writing** from the service owner, with [privacy.md](privacy.md) shared and reviewed (what is and isn't collected).
- [ ] **Collector and Postgres run in the client's own account** (§8). No data leaves it; the collector's only outbound calls are the alert channels and SMTP server you configure (and AWS's ALB key endpoint if you use ALB sign-in).
- [ ] **Dashboard private** (§8, "Network exposure"): reachable only from the client's network/VPN. Only `/status/*` and `/embed.js` may be public, ideally through a separate public-paths-only instance.
- [ ] **Real Slack and/or email test alert received**: Settings → Alert channels → **Send test alert** shows "Sent" and the message arrived where on-call will see it.
- [ ] **SDK `debug` off** (`debug: false` or unset) in production.
- [ ] **Discovered providers reviewed in the first hour**: Providers lists every third-party host the service calls (auto-discovery is on by default). Hide anything internal or unwanted (pushed to the SDK within a minute), or set `autoDiscover: false` to record only listed providers.
- [ ] Provider list reviewed: names, hosts, and explicit `routes` for any API that puts names, letters-only IDs or other personal values in its paths.
- [ ] **One API key per service** (Settings → API keys, `ingest` scope), stored as a secret together with `THEIRSIDE_ADMIN_TOKEN`, `THEIRSIDE_SECRET_KEY` and the database password (not in the repo, not in plain task definitions).
- [ ] **Dashboard accounts**: everyone who needs the dashboard has their own account (invites, or sign-in through the client's identity proxy), admins only for those who manage users, keys, channels and status pages (others are members), two-factor sign-in required for everyone (Settings → Users), and `THEIRSIDE_SECRET_KEY` backed up ([security.md](security.md)). The admin token is kept for break-glass only.
- [ ] **Removal rehearsed**: the one commit that takes the SDK out is known (below) and `THEIRSIDE_ENABLED=false` works as an instant kill switch without a code change.

### Removing the SDK in one commit

Everything the SDK needs lives in three places, so one commit reverts it:

1. delete `src/instrumentation.ts` and the `import './instrumentation';` line at the top of `src/main.ts`;
2. delete the `MonitorShutdown` provider (§3) and its entry in the module's `providers`;
3. remove `@theirside/sdk` from `package.json` (and the lockfile).

Nothing else in the service references the SDK; HTTP clients, modules and tests are untouched. For an immediate stop without a deploy of new code, set `THEIRSIDE_ENABLED=false` and restart: `init()` then does nothing.

## 1. Install

Until the package is published to npm, install it from a tarball built in this repo:

```sh
pnpm install && pnpm --filter @theirside/sdk build
cd packages/sdk && pnpm pack                # → packages/sdk/theirside-sdk-0.1.0.tgz
# in the service:
npm install /path/to/theirside-sdk-0.1.0.tgz
```

Once published: `npm install @theirside/sdk`. Zero runtime dependencies; Node 18.18+; CommonJS and ESM.

## 2. Initialise before anything else

Create `src/instrumentation.ts`. The minimum is three lines:

```ts
import { init } from '@theirside/sdk';

init({ apiKey: process.env.THEIRSIDE_API_KEY, endpoint: process.env.THEIRSIDE_COLLECTOR_URL });
```

Every third-party API the service calls is discovered and grouped into providers by the collector (catalog names like Stripe, else the domain: `api.acme.com` + `files.acme.com` → `acme.com`). Loopback, private networks, cloud metadata, internal names (`redis`, `*.svc`, `*.internal`), telemetry hosts and the collector are never recorded. Rename, merge, hide or mark providers internal in the dashboard; it reaches the SDK within a minute.

A typical production setup adds a few optional fields:

```ts
import { init } from '@theirside/sdk';
import { ClsServiceManager } from 'nestjs-cls'; // if you use nestjs-cls; see "Correlation IDs"

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  service: 'payments-api',
  environment: process.env.NODE_ENV,
  enabled: process.env.THEIRSIDE_ENABLED !== 'false',
  // your own services, never recorded (in addition to the automatic exclusions)
  internalHosts: ['*.payments.internal.example.com'],
  // optional overrides: a fixed name and routes for a provider in code
  providers: [
    { name: 'Acme Cards', hosts: ['api.acmecards.com'], routes: ['/v2/cards/:cardId/activate'] },
  ],
  getCorrelationId: () => ClsServiceManager.getClsService()?.getId(),
});
```

Make it the **first import** of `src/main.ts`, before `@nestjs/core` and before any module that creates HTTP clients:

```ts
import './instrumentation';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(3000);
}
bootstrap();
```

Order relative to AWS X-Ray (`captureHTTPsGlobal`), Sentry and OpenTelemetry does not matter; coexistence in either order is covered by tests (`packages/sdk/test/coexist.test.ts`) and the demo runs with X-Ray on. If the service already has an `instrument.ts` for Sentry/OTel, put `init` there.

The SDK never throws into your code and never waits on the network in the request path. With a wrong or missing config it stays off (set `debug: true` to see why).

## 3. Flush on shutdown

With `app.enableShutdownHooks()`, add one provider (any module):

```ts
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { shutdown } from '@theirside/sdk';

@Injectable()
export class MonitorShutdown implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await shutdown(); // flushes queued events, capped at 2 s
  }
}
```

The SDK also flushes on `SIGTERM`/`beforeExit` by itself; the hook makes it deterministic on ECS task stops and deploys.

## 4. Environment variables

| Variable | Example | |
|---|---|---|
| `THEIRSIDE_API_KEY` | `tsd_live_…` | Project key with the `ingest` scope. Create one per service under Settings → API keys (shown once); rotate by creating a new key, deploying it, then revoking the old one. Secret. |
| `THEIRSIDE_COLLECTOR_URL` | `http://theirside.internal:4318` | Collector URL reachable from the service (private network). |
| `NODE_ENV` | `production` | Used as `environment`. |
| `THEIRSIDE_ENABLED` | `false` | Optional kill switch (only if you wire it as above). |

## 5. Providers and routes

- Listing providers is optional: with auto-discovery (default) every third-party host is recorded and the collector groups hosts into providers (catalog name or registrable domain). List a provider to choose its name, hosts and routes in code (`*.example.com` matches any subdomain, not the apex); with `autoDiscover: false` only listed providers are recorded.
- Paths are templated automatically (IDs, UUIDs, card numbers, emails, prefixed IDs like `cus_123` → `:id`; query strings dropped). A plain word is sent only if every part of it is a known API word (built-in vocabulary, or the provider's allowed words in the dashboard), so names never go out; words outside the vocabulary (product slugs, a provider's own resource names) stay `:id` (details: [privacy.md](privacy.md); `pathPrivacy: 'balanced'` drops the vocabulary check for providers whose paths carry no personal data and instead sends a word once it has been seen 5 times). Add explicit `routes` when:
  - a provider uses IDs without digits (`acct_pnptbshs`) or resource names outside the vocabulary that you want to see;
  - an endpoint is called rarely and you want its real name from the first call;
  - you want a nicer name than `:id` (`/v2/cards/:cardId/activate`).
- Loopback, private networks, cloud metadata, internal names (`redis`, `*.svc`, `*.internal`), telemetry hosts and the collector are never recorded. Add your own services' host patterns to `internalHosts`, or mark a provider internal in the dashboard.

## 6. Correlation IDs

`getCorrelationId` is read at the start of every outgoing call, inside the incoming request's async context. With `nestjs-cls`:

```ts
ClsModule.forRoot({
  global: true,
  middleware: { mount: true, generateId: true, idGenerator: (req) => req.headers['x-request-id'] ?? randomUUID() },
});
```

Without `nestjs-cls`, use your own `AsyncLocalStorage` (`getCorrelationId: () => als.getStore()?.requestId`). Return only an opaque request ID, never personal data. The provider's own request ID (`x-request-id`, `request-id`, `x-amzn-requestid`, `cf-ray` response headers) is captured automatically and appears in incident summaries.

## 7. Verify it works

1. Start the service with `debug: true` once: you should see `[theirside] started (… N providers …)` and no flush errors.
2. Make a few calls that hit a provider, wait ~10 s.
3. Dashboard → **Settings → SDK health**: your service, last seen seconds ago, 0 dropped events.
4. Dashboard → **Providers**: your providers with calls/min. Or from a shell:
   ```sh
   curl -s -H "Authorization: Bearer $THEIRSIDE_API_KEY" "$THEIRSIDE_COLLECTOR_URL/v1/health" | jq '.providers[] | {name, status, callsPerMin}'
   ```
5. `getStats()` from the SDK returns `{ queued, dropped, sent, failedFlushes, lastFlushError }` if you want it in your own health endpoint.

## 8. Running the collector in the client's infrastructure

The collector is one Docker image plus a Postgres database (13+; tested on 16). It serves ingest, the dashboard, the health API and the status page on one port (4318). Several replicas may run behind a load balancer; one of them runs the scheduler (Postgres advisory lock).

The image is published as **`ghcr.io/theirside/collector:<version>`** for linux/amd64 and linux/arm64, e.g. `ghcr.io/theirside/collector:0.2.1`. Tags: the exact version, `<major>.<minor>` (moves to the latest patch) and `latest`; prereleases only get their exact version. Pin the exact version in production. Each image carries a build provenance attestation and an SBOM (`gh attestation verify oci://ghcr.io/theirside/collector:0.2.1 -R theirside/theirside`).

**Upgrading** means running the new image: each start applies its database migrations (several replicas wait for each other). From 0.1.0 to 0.2.0:

- Every existing user becomes an **admin**, and new invites default to **member** ([roles](security.md#roles)).
- `THEIRSIDE_TRUST_PROXY` now believes `X-Forwarded-For` only from private and loopback addresses. If your load balancer reaches the collector from a public address, set its CIDRs ([security.md](security.md#brute-force-protection)).
- Sign-in failures delay one email at one address instead of locking the account.
- Reset links, turning off someone's 2FA, role changes and removals ask for your password (and 2FA code) again; scripts using `Authorization: Bearer <THEIRSIDE_ADMIN_TOKEN>` are not affected.

From 0.2.0 to 0.2.1: endpoints quiet in the 5-minute window stay listed as `idle`. In `/v1/health` they appear with `status: "idle"`, `lastCallAt` and `rangeTotals` (endpoints called within `?range=`, default 24h), and a provider without calls in the window is `idle` instead of `unknown` when it was ever called. A script that reads `status` should treat `idle` like `unknown`.

### Mirroring the image into a private registry

If the cluster can't pull from ghcr.io, or policy requires images from your own registry, copy it once per version. ECR example:

```sh
AWS_ACCOUNT=<account> AWS_REGION=<region> VERSION=0.2.1
ECR=$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com
aws ecr create-repository --repository-name theirside-collector --region $AWS_REGION   # first time only
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR

docker pull --platform linux/amd64 ghcr.io/theirside/collector:$VERSION   # or linux/arm64 for Graviton
docker tag ghcr.io/theirside/collector:$VERSION $ECR/theirside-collector:$VERSION
docker push $ECR/theirside-collector:$VERSION
```

`docker pull` + `push` copies one architecture. To copy both, with the signatures and SBOM, use `docker buildx imagetools create --tag $ECR/theirside-collector:$VERSION ghcr.io/theirside/collector:$VERSION` (or `crane copy`) instead of the last three lines.

### Building from source

To build the image yourself (e.g. with local changes), from the repo root:

```sh
docker build -f docker/Dockerfile.collector -t <registry>/theirside-collector:0.2.1 .
docker push <registry>/theirside-collector:0.2.1
```

With docker compose, set `THEIRSIDE_VERSION=local` and add `--build`. Compose builds only for `local`: a release version must be pulled, and if the pull fails (or `--build` is passed with it) the build stops at once with an error, so a source build never runs under a release tag.

### Option A: docker compose on a VM

On a small VM (1 vCPU / 2 GB is plenty; measured 25k events/s on 1 CPU, see `docs/benchmarks.md`) inside the client's network:

```sh
git clone <this repo> theirside && cd theirside
cp .env.example .env    # then fill in: THEIRSIDE_VERSION (the release to pull), POSTGRES_PASSWORD,
                        # THEIRSIDE_BOOTSTRAP_API_KEY, THEIRSIDE_ADMIN_TOKEN, THEIRSIDE_SECRET_KEY,
                        # THEIRSIDE_PUBLIC_URL, SMTP for email alerts, invites and resets
chmod 600 .env
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

Put TLS in front (the VM's existing reverse proxy or a load balancer) and keep the VM's port 4318 closed to the internet (see "Network exposure"). Back up the `pgdata` volume, or point `DATABASE_URL` at a managed Postgres instead.

### Option B: ECS Fargate + RDS

- **RDS for PostgreSQL** 13+ (`db.t4g.small` is enough to start), in private subnets, encrypted, automated backups on. Create a database and user for the collector.
- **TLS to RDS**: RDS for PostgreSQL 15+ refuses unencrypted connections by default (`rds.force_ssl=1`), so `DATABASE_URL` needs an `sslmode`. Either `?sslmode=no-verify` (encrypted; the server certificate is not checked, which is common inside a private VPC), or, stricter, `?sslmode=verify-full&sslrootcert=/app/rds-global-bundle.pem` with AWS's RDS CA bundle (`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`) added to the image (`FROM ghcr.io/theirside/collector:0.2.1` + `COPY global-bundle.pem /app/rds-global-bundle.pem`, pushed to your registry). Plain `sslmode=require` fails on RDS: it checks the certificate against Node's built-in CAs, which don't include the RDS CA.
- **Secrets Manager**: `DATABASE_URL`, `THEIRSIDE_BOOTSTRAP_API_KEY`, `THEIRSIDE_ADMIN_TOKEN`, `THEIRSIDE_SECRET_KEY` (2FA; back it up, [security.md](security.md)) and `THEIRSIDE_SMTP_PASS` if email is used.
- **ECS service**: 1–2 tasks of the definition below in private subnets, behind an **internal** ALB (scheme `internal`) on HTTPS with a certificate for a private name (e.g. `theirside.client.internal`), for the services' SDK traffic and the dashboard. See "Network exposure" for the public status page.
- **Security groups**: internal ALB ← the services' security groups and the office/VPN CIDR on 443; collector tasks ← internal ALB (and the public-paths ALB, if any) on 4318; RDS ← collector tasks on 5432; collector → Slack/SMTP/webhook endpoints on 443/587 for alerts only.

Minimal task definition (placeholders in `<>`):

```json
{
  "family": "theirside-collector",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::<account>:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "collector",
      "image": "<account>.dkr.ecr.<region>.amazonaws.com/theirside-collector:0.2.1",
      "essential": true,
      "portMappings": [{ "containerPort": 4318, "protocol": "tcp" }],
      "environment": [
        { "name": "THEIRSIDE_DEPLOYMENT_MODE", "value": "self_hosted" },
        { "name": "THEIRSIDE_PUBLIC_URL", "value": "https://theirside.<client-domain>" },
        { "name": "THEIRSIDE_RAW_RETENTION_DAYS", "value": "30" },
        { "name": "THEIRSIDE_ROLLUP_RETENTION_DAYS", "value": "90" },
        { "name": "LOG_LEVEL", "value": "info" }
      ],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:theirside/database-url" },
        { "name": "THEIRSIDE_BOOTSTRAP_API_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:theirside/bootstrap-api-key" },
        { "name": "THEIRSIDE_ADMIN_TOKEN", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:theirside/admin-token" },
        { "name": "THEIRSIDE_SECRET_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:theirside/secret-key" }
      ],
      "healthCheck": {
        "command": ["CMD", "node", "-e", "fetch('http://127.0.0.1:4318/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
        "interval": 15,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 30
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/theirside",
          "awslogs-region": "<region>",
          "awslogs-stream-prefix": "collector"
        }
      }
    }
  ]
}
```

Use `/readyz` for the ALB target group health check (it returns 503 while the database is unreachable); `/healthz` stays 200 so ECS doesn't restart tasks during a database blip. Migrations run automatically at start (advisory-locked, safe with several tasks).

### Network exposure

**The dashboard must only be reachable on a private network.** It shows every provider, endpoint, error and incident; user sign-in (and the break-glass admin token) is its only lock. Ingest (`/v1/ingest`), the health API (`/v1/health`, `/v1/incidents`), login (`/v1/auth/*`) and the admin API (`/v1/admin/*`) are private too. The only paths that may ever be public are **`/status/*`** and **`/embed.js`**, and only if you use the status page for the client's customers.

The simplest safe setup is two services from the same image and database:

| | Private instance (all of it) | Public instance (optional) |
|---|---|---|
| Serves | ingest, dashboard, APIs, status page | only `/status/*`, `/embed.js`, `/healthz`, `/readyz`; everything else answers 404 |
| Settings | as above | add `THEIRSIDE_PUBLIC_PATHS_ONLY=true`; no `THEIRSIDE_BOOTSTRAP_API_KEY`/`THEIRSIDE_ADMIN_TOKEN` needed |
| Load balancer | internal ALB, reachable from the services' SGs and the office/VPN | internet-facing ALB, or a CDN in front of it |
| Scheduler | runs here (leader-elected) | never runs (implied by public-paths-only) |

Because the public instance refuses everything outside the allow-list itself, a misconfigured listener rule can't expose the dashboard. If you'd rather run one service, the public ALB must forward only path patterns `/status/*` and `/embed.js` to it, with a default action of fixed-response 404, and the rest of the traffic must come through the internal ALB.

Set `THEIRSIDE_PUBLIC_URL` to the **private** dashboard URL (alert links point there). Status page links and the embed snippet use the address they are requested on, so open Settings → Status page through the URL partners should use, or give partners the public instance's `https://status.<client-domain>/status/<token>`.

SDK traffic: point `THEIRSIDE_COLLECTOR_URL` at the internal ALB over HTTPS so the API key never crosses the network in clear text.

### Collector environment variables

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | `postgres://user:pass@host:5432/db` |
| `PORT` | `4318` | |
| `THEIRSIDE_PUBLIC_URL` | – | Dashboard URL for "Open in dashboard" links in alerts (no link when unset) and the session cookie's `Secure` flag; status page and embed URLs fall back to the request origin. |
| `THEIRSIDE_BOOTSTRAP_API_KEY` | – | First start: creates the org, project, status page and this key (`tsd_live_` + ≥ 16 chars). The first user comes from the dashboard's setup page. |
| `THEIRSIDE_ADMIN_TOKEN` | – | Completes the setup page (or use the setup code from the log) and is the break-glass sign-in (and `Bearer` for scripts). Unset to turn it off. |
| `THEIRSIDE_SECRET_KEY` / `THEIRSIDE_SECRET_KEY_PREVIOUS` | – | Encrypts two-factor secrets (≥ 32 characters, `openssl rand -base64 32`); required for 2FA. Back it up; rotate by moving the old key to `_PREVIOUS` ([security.md](security.md)). |
| `THEIRSIDE_TRUST_PROXY` | private ranges | Which proxies' `X-Forwarded-*` to believe (client IP for sign-in limits, https detection): by default those on private and loopback addresses; or the load balancers' CIDRs, a hop count, `false`, or `true` for any (logged as a warning). |
| `THEIRSIDE_SESSION_MAX_AGE_HOURS` / `THEIRSIDE_SESSION_IDLE_HOURS` | `168` / `24` | Dashboard session lifetime and idle timeout. |
| `THEIRSIDE_AUTH_PROXY` (`header`, `alb`), `THEIRSIDE_AUTH_PROXY_TRUSTED_IPS`, `THEIRSIDE_AUTH_PROXY_HEADER`, `THEIRSIDE_AUTH_PROXY_ALB_ARN`, `THEIRSIDE_AUTH_PROXY_AUTO_CREATE` | off | Sign-in through an identity proxy or an ALB with OIDC ([security.md](security.md#sign-in-through-an-identity-proxy)). |
| `THEIRSIDE_ADMIN_EMAILS` | none | Comma-separated emails that become admins when the identity proxy creates their account; others are members ([security.md](security.md#roles)). |
| `THEIRSIDE_RAW_RETENTION_DAYS` / `THEIRSIDE_ROLLUP_RETENTION_DAYS` | `30` / `90` | |
| `THEIRSIDE_SMTP_URL` (or `THEIRSIDE_SMTP_HOST`, `_PORT`, `_SECURE`, `_REQUIRE_TLS`, `_USER`, `_PASS`), `THEIRSIDE_SMTP_FROM` | – | Needed for email alert channels. `smtp://user:pass@host:587` uses STARTTLS, `smtps://…:465` TLS; TLS is required when credentials are set. Gmail, SES and Postmark examples: `.env.example`. |
| `THEIRSIDE_LICENSE_KEY` | – | Paid features; never needed for ingest or alerts. |
| `THEIRSIDE_CATALOG_OVERRIDE` | – (compose: the demo's `.test`-only file) | JSON file with extra catalog entries (`{ "providers": [{ "name", "category", "domains": [] }] }`), e.g. to name an internal partner API. |
| `THEIRSIDE_PUBLIC_PATHS_ONLY` | `false` | `true` for a public-facing instance: serves only `/status/*`, `/embed.js` and health checks, runs no scheduler. |
| `LOG_LEVEL` | `info` | |

Full list: `docs/architecture.md` §3.3.

### After deploying

1. Open the dashboard (`THEIRSIDE_PUBLIC_URL`). The setup page creates your account; it asks for `THEIRSIDE_ADMIN_TOKEN` or the setup code from the collector log. Turn on two-factor sign-in on your account page, invite the team (Settings → Users) and tick **Require two-factor sign-in for everyone**. With an ALB in front, you can instead let people sign in with the company account ([security.md](security.md#aws-application-load-balancer)).
2. **Settings → Alert channels**: add Slack/email/webhook, press **Send test alert**; it must say "Sent" and arrive. A failure shows the exact reason (Slack's error, SMTP authentication, connection refused).
3. **Settings → API keys**: create one key per service (`ingest`), store each as that service's `THEIRSIDE_API_KEY` secret. Revoke the bootstrap key once every service has its own, or keep it only for the health API.
4. Deploy the service with the SDK; check **SDK health** and **Providers** as in step 7.
5. **Settings → Providers**: add support emails/URLs (they go into the incident summary for the provider) and, if you will use the status page, public display names and "show on status page".
6. Baselines learn for 24 h; until then endpoints show "learning" and use conservative defaults, so real outages still alert.

## Troubleshooting

| Symptom | Check |
|---|---|
| No SDK in "SDK health" | `THEIRSIDE_COLLECTOR_URL` reachable from the service (security group, DNS)? `debug: true` shows `flush failed (ECONNREFUSED)` etc. |
| SDK present, provider missing | The host is excluded (private IP, single-label or `.internal` name, telemetry host, `internalHosts`) or hidden/internal in the dashboard; or `autoDiscover: false` and the host isn't in `providers`. `debug: true` doesn't log per call; compare with the host the service really calls. |
| Only listed providers show up; log says `auto-discovery is off for this process` | The collector predates auto-discovery (no `/v1/sdk-config`). Upgrade the collector, then restart the service. |
| An internal service shows up as a provider | Mark it internal (Settings → Providers) or add it to `internalHosts`; the SDK stops sending it within a minute. |
| One provider shows up as several | Merge them (Settings → Providers → Merge into…); history moves too. |
| `lastFlushError: http_401` | Wrong `THEIRSIDE_API_KEY` or a key without the `ingest` scope. |
| Endpoints show IDs or `/:overflow` | Add explicit `routes` for that provider in the dashboard (pushed to the SDK) or in `init()` (see §5). Near-duplicate templates are also merged daily. |
| Dropped events grow | Collector down or slow; the SDK keeps at most `maxQueue` (10,000) events and drops the oldest. Nothing else is affected. |
