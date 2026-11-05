-- Initial schema. Every tenant-owned table carries org_id, and project_id where
-- relevant (architecture §4/§5). Ids are text with a type prefix (org_, prj_, ...).

-- ---------------------------------------------------------------- tenancy
CREATE TABLE orgs (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          text PRIMARY KEY,
  email       text,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE memberships (
  org_id      text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE projects (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_org_idx ON projects (org_id);

CREATE TABLE api_keys (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- sha256 of the full key; the key itself is never stored
  key_hash      text NOT NULL UNIQUE,
  -- first characters, e.g. tsd_live_ab12, for display only
  key_prefix    text NOT NULL,
  scopes        text[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_project_idx ON api_keys (org_id, project_id);

-- ---------------------------------------------------------------- config
CREATE TABLE providers (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id           text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- must equal the provider name the SDK sends
  name                 text NOT NULL,
  host_patterns        text[] NOT NULL DEFAULT '{}',
  explicit_routes      text[] NOT NULL DEFAULT '{}',
  support_email        text,
  support_url          text,
  support_notes        text,
  public_display_name  text,
  is_public            boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX providers_org_idx ON providers (org_id, project_id);

CREATE TABLE alert_channels (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('slack', 'email', 'webhook')),
  name        text NOT NULL,
  -- kind-specific settings (webhook URL, recipients, signing secret)
  config      jsonb NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_channels_project_idx ON alert_channels (org_id, project_id);

CREATE TABLE status_pages (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id        text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  public_token      text NOT NULL UNIQUE,
  title             text NOT NULL,
  -- empty = every provider marked is_public
  provider_filter   text[] NOT NULL DEFAULT '{}',
  theme             text NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_pages_project_idx ON status_pages (org_id, project_id);

-- Per-project overrides of incident thresholds; absent keys use defaults.
CREATE TABLE settings (
  org_id      text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thresholds  jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE sdk_instances (
  org_id          text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service         text NOT NULL,
  environment     text NOT NULL,
  sdk_name        text NOT NULL,
  sdk_version     text NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- cumulative events the SDK reported as dropped
  dropped_events  bigint NOT NULL DEFAULT 0,
  last_flush_error text,
  PRIMARY KEY (org_id, project_id, service, environment)
);

CREATE TABLE usage_daily (
  org_id                   text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id               text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day                      date NOT NULL,
  calls_ingested           bigint NOT NULL DEFAULT 0,
  events_dropped_reported  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, project_id, day)
);

-- ---------------------------------------------------------------- events
-- Raw events, declaratively partitioned by received day. Partitions are created
-- 3 days ahead and dropped after THEIRSIDE_RAW_RETENTION_DAYS by the scheduler.
CREATE TABLE events (
  org_id               text NOT NULL,
  project_id           text NOT NULL,
  received_at          timestamptz NOT NULL,
  ts                   timestamptz NOT NULL,
  service              text NOT NULL,
  environment          text NOT NULL,
  sdk_version          text NOT NULL,
  provider             text NOT NULL,
  host                 text NOT NULL,
  method               text NOT NULL,
  endpoint             text NOT NULL,
  status               smallint,
  duration_ms          real NOT NULL,
  outcome              text NOT NULL,
  error_code           text,
  correlation_id       text,
  provider_request_id  text
) PARTITION BY RANGE (received_at);
CREATE INDEX events_lookup_idx ON events (org_id, project_id, provider, endpoint, ts);

-- One row per (org, project, environment, provider, endpoint, method, minute).
-- h0..h17 are the latency histogram buckets (packages/shared/src/histogram.ts).
CREATE TABLE rollups_1m (
  org_id        text NOT NULL,
  project_id    text NOT NULL,
  environment   text NOT NULL,
  provider      text NOT NULL,
  endpoint      text NOT NULL,
  method        text NOT NULL,
  minute        timestamptz NOT NULL,
  total         integer NOT NULL DEFAULT 0,
  ok            integer NOT NULL DEFAULT 0,
  http_4xx      integer NOT NULL DEFAULT 0,
  http_5xx      integer NOT NULL DEFAULT 0,
  timeout       integer NOT NULL DEFAULT 0,
  conn_reset    integer NOT NULL DEFAULT 0,
  conn_refused  integer NOT NULL DEFAULT 0,
  dns           integer NOT NULL DEFAULT 0,
  tls           integer NOT NULL DEFAULT 0,
  aborted       integer NOT NULL DEFAULT 0,
  other_error   integer NOT NULL DEFAULT 0,
  status_429    integer NOT NULL DEFAULT 0,
  latency_sum_ms double precision NOT NULL DEFAULT 0,
  h0 integer NOT NULL DEFAULT 0,  h1 integer NOT NULL DEFAULT 0,  h2 integer NOT NULL DEFAULT 0,
  h3 integer NOT NULL DEFAULT 0,  h4 integer NOT NULL DEFAULT 0,  h5 integer NOT NULL DEFAULT 0,
  h6 integer NOT NULL DEFAULT 0,  h7 integer NOT NULL DEFAULT 0,  h8 integer NOT NULL DEFAULT 0,
  h9 integer NOT NULL DEFAULT 0,  h10 integer NOT NULL DEFAULT 0, h11 integer NOT NULL DEFAULT 0,
  h12 integer NOT NULL DEFAULT 0, h13 integer NOT NULL DEFAULT 0, h14 integer NOT NULL DEFAULT 0,
  h15 integer NOT NULL DEFAULT 0, h16 integer NOT NULL DEFAULT 0, h17 integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, project_id, environment, provider, endpoint, method, minute)
);
CREATE INDEX rollups_1m_minute_idx ON rollups_1m (org_id, project_id, minute);

-- ---------------------------------------------------------------- incidents
CREATE TABLE incidents (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id           text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment          text NOT NULL,
  provider             text NOT NULL,
  scope                text NOT NULL CHECK (scope IN ('endpoint', 'provider')),
  kind                 text NOT NULL CHECK (kind IN ('errors', 'latency')),
  status               text NOT NULL CHECK (status IN ('open', 'resolved')),
  opened_at            timestamptz NOT NULL,
  resolved_at          timestamptz,
  last_alerted_rate    double precision,
  peak_error_rate      double precision NOT NULL DEFAULT 0,
  peak_p95_ms          double precision,
  baseline             jsonb NOT NULL DEFAULT '{}',
  summary              text NOT NULL DEFAULT '',
  sample_request_ids   text[] NOT NULL DEFAULT '{}',
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_project_status_idx ON incidents (org_id, project_id, status, opened_at DESC);

CREATE TABLE incident_endpoints (
  incident_id   text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  org_id        text NOT NULL,
  project_id    text NOT NULL,
  endpoint      text NOT NULL,
  method        text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  -- set when this endpoint recovered while the incident stays open for others
  recovered_at  timestamptz,
  peak_error_rate double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (incident_id, endpoint, method)
);
CREATE INDEX incident_endpoints_lookup_idx ON incident_endpoints (org_id, project_id, endpoint, method);

CREATE TABLE baselines (
  org_id               text NOT NULL,
  project_id           text NOT NULL,
  environment          text NOT NULL,
  provider             text NOT NULL,
  endpoint             text NOT NULL,
  method               text NOT NULL,
  provider_error_rate  double precision NOT NULL,
  rate_4xx             double precision NOT NULL,
  rate_429             double precision NOT NULL,
  p50_ms               double precision,
  p95_ms               double precision,
  sample_size          bigint NOT NULL,
  history_minutes      integer NOT NULL,
  learning             boolean NOT NULL,
  computed_at          timestamptz NOT NULL,
  PRIMARY KEY (org_id, project_id, environment, provider, endpoint, method)
);

CREATE TABLE alert_deliveries (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id    text NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  incident_id   text REFERENCES incidents(id) ON DELETE CASCADE,
  -- open | escalation | resolve | test
  event         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX alert_deliveries_pending_idx ON alert_deliveries (status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX alert_deliveries_project_idx ON alert_deliveries (org_id, project_id, created_at DESC);

-- Per-install values (contributor id for the future network uplink, session secret).
CREATE TABLE install_meta (
  key    text PRIMARY KEY,
  value  text NOT NULL
);
