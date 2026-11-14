---
title: Self-hosting
description: Run the collector with Docker Compose, on ECS Fargate or Kubernetes; settings, upgrades, backups, a load balancer in front, and a public status page.
order: 6
---

# Self-hosting

The collector is one Docker image (`ghcr.io/theirside/collector`, amd64 and arm64) plus Postgres 13 or later. It receives events from your apps, runs detection and alerts, and serves the dashboard and status page on port 4318. Your data never leaves your infrastructure. 1 vCPU and 2 GB is plenty to start.

## Docker Compose

```sh
mkdir theirside && cd theirside
curl -fsSLO https://theirside.dev/compose.yml
docker compose -f compose.yml up -d --wait
docker compose -f compose.yml logs collector | grep -m1 "/setup"
```

`compose.yml` runs Postgres and the collector; every setting in it is optional and commented. Put your settings in a `.env` file next to it (Compose reads it), for example:

<!-- docs-check: skip (an env file, not code) -->
```sh
THEIRSIDE_PUBLIC_URL=https://theirside.internal.example.test
POSTGRES_PASSWORD=change-me
THEIRSIDE_SECRET_KEY=output-of-openssl-rand-base64-32
THEIRSIDE_SMTP_URL=smtps://user:password@smtp.example.test:465
THEIRSIDE_SMTP_FROM=alerts@example.test
```

Then `docker compose -f compose.yml up -d --wait` again. Every variable: [Configuration](configuration.md#collector-environment-variables).

## ECS Fargate

Run the image as a service in private subnets with RDS for PostgreSQL, behind an **internal** load balancer. Keep `DATABASE_URL` (`postgres://user:password@<instance>.rds.amazonaws.com:5432/theirside?sslmode=verify-full`) and the other secrets in Secrets Manager:

```json
{
  "family": "theirside-collector",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::123456789012:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "collector",
      "image": "ghcr.io/theirside/collector:0.6",
      "essential": true,
      "portMappings": [{ "containerPort": 4318, "protocol": "tcp" }],
      "environment": [
        { "name": "THEIRSIDE_PUBLIC_URL", "value": "https://theirside.internal.example.test" },
        { "name": "THEIRSIDE_DATABASE_CA_FILE", "value": "/app/certs/rds-global-bundle.pem" }
      ],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:eu-west-1:123456789012:secret:theirside/database-url" },
        { "name": "THEIRSIDE_SECRET_KEY", "valueFrom": "arn:aws:secretsmanager:eu-west-1:123456789012:secret:theirside/secret-key" }
      ],
      "healthCheck": {
        "command": ["CMD", "node", "-e", "fetch('http://127.0.0.1:4318/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
        "interval": 15,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 30
      }
    }
  ]
}
```

- **RDS**: end `DATABASE_URL` with `?sslmode=verify-full` and set `THEIRSIDE_DATABASE_CA_FILE=/app/certs/rds-global-bundle.pem`, as in the task definition above: the image includes AWS's RDS CA bundle, so the database's certificate is checked with nothing else to install ([Database TLS](#database-tls)).
- **Load balancer target group**: health check on `/readyz`. Several tasks are fine: migrations are locked and one task runs the jobs.
- Can't pull from ghcr.io? Copy the image into ECR once per version (`docker pull`, `docker tag`, `docker push`).

## Kubernetes

A minimal setup with your own Postgres. The `theirside` secret holds `DATABASE_URL` and `THEIRSIDE_SECRET_KEY`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: theirside-collector
spec:
  replicas: 1
  selector:
    matchLabels: { app: theirside-collector }
  template:
    metadata:
      labels: { app: theirside-collector }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: collector
          image: ghcr.io/theirside/collector:0.6
          ports:
            - containerPort: 4318
          env:
            - name: THEIRSIDE_PUBLIC_URL
              value: https://theirside.internal.example.test
          envFrom:
            - secretRef:
                name: theirside
          readinessProbe:
            httpGet: { path: /readyz, port: 4318 }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /healthz, port: 4318 }
            initialDelaySeconds: 30
            periodSeconds: 15
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits: { memory: 1Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: theirside-collector
spec:
  selector: { app: theirside-collector }
  ports:
    - port: 4318
      targetPort: 4318
```

```sh
kubectl create secret generic theirside \
  --from-literal=DATABASE_URL='postgres://theirside:password@postgres.db.svc:5432/theirside' \
  --from-literal=THEIRSIDE_SECRET_KEY="$(openssl rand -base64 32)"
kubectl apply -f theirside.yaml
kubectl logs deploy/theirside-collector | grep -m1 "/setup"
```

Apps in the cluster then use `THEIRSIDE_COLLECTOR_URL=http://theirside-collector.<namespace>.svc:4318`. `/readyz` answers 503 while the database is unreachable; `/healthz` stays 200, so a database blip doesn't restart the pod.

## Database TLS

To encrypt the connection to Postgres and check that it really is your database, end `DATABASE_URL` with `?sslmode=verify-full`. The certificate must then chain to a trusted CA and name the host in the URL.

- **AWS RDS**: set `THEIRSIDE_DATABASE_CA_FILE=/app/certs/rds-global-bundle.pem`. The image includes AWS's global RDS CA bundle at that path.
- **Another provider, or your own CA** (Cloud SQL, Azure, a Postgres with your company's CA): mount its CA certificate file into the container and point `THEIRSIDE_DATABASE_CA_FILE` at it.
- **A certificate from a public CA**: `?sslmode=verify-full` alone is enough.

`?sslmode=no-verify` also encrypts the connection but skips the certificate check, so anything on the network path could pose as your database: use it for local testing only. In PostgreSQL's own terms `require`, `prefer` and `allow` don't verify the certificate either; ask for `verify-full`.

The collector checks this at startup and never blocks on it. When the database is on another machine (anything but `localhost`, `127.0.0.1`, `::1`, a Unix socket or a single-label name like the Compose service `postgres`; private IPs count as another machine) and the certificate isn't verified, it logs one warning with the exact fix, and admins see the same notice under **Settings → SDK health**.

## Upgrades

1. Read the version's release notes: they say what changes and when to upgrade the collector before your apps' SDK.
2. Change the image tag, or keep the minor tag (`:0.6`) and pull: Compose with `docker compose -f compose.yml pull` then `up -d --wait`, Kubernetes and ECS by rolling out the new image.
3. Database migrations run when the new version starts, before it serves traffic; there's nothing to run by hand.

A minor tag (`0.6`) moves to each patch release; a new minor (`0.7`) needs the tag changed. Older SDKs keep working with newer collectors.

## Backups

Everything is in Postgres: back it up like any other database (managed snapshots, or `pg_dump`). With Compose:

```sh
docker compose -f compose.yml exec -T postgres pg_dump -U theirside theirside | gzip > theirside-$(date +%F).sql.gz
```

Also keep `THEIRSIDE_SECRET_KEY` somewhere safe: without it, two-factor codes can't be checked after a restore.

## Behind a load balancer

- **Keep it private.** The dashboard and every `/v1/*` path (ingest, the APIs, sign-in) belong on a private network: an internal load balancer reachable from your apps and your office or VPN. Only `/status/*`, `/embed.js` and `/fonts/*` may ever be public (the status page, below).
- **TLS** at the load balancer; point apps' `THEIRSIDE_COLLECTOR_URL` at the HTTPS address, so API keys never cross the network in clear text.
- **`THEIRSIDE_PUBLIC_URL`**: the address people use, for links in alerts and secure cookies.
- **`THEIRSIDE_TRUST_PROXY`**: proxies on private addresses are trusted for `X-Forwarded-For` by default; set your load balancers' subnets to be stricter.
- **Health check**: `/readyz`.
- **Company sign-in**: an identity proxy or an AWS ALB with OIDC can sign people in (`THEIRSIDE_AUTH_PROXY`, [Configuration](configuration.md#sign-in-and-security)).

## A public status page

The status page shows your providers' health to your own customers. To publish it without exposing anything else, run a second instance of the same image on the same database with `THEIRSIDE_PUBLIC_PATHS_ONLY=true` behind an internet-facing load balancer or CDN. It serves only `/status/*`, `/embed.js`, `/fonts/*` and health checks, answers 404 to everything else, and runs no jobs, so a misconfigured listener rule can't expose the dashboard. Choose what it shows under **Settings → Status page** and in each provider's settings.
