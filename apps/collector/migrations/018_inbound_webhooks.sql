-- Inbound webhook monitoring (docs/architecture.md §10, 2026-11-10). Deliveries our app receives
-- go through the same raw events table with a direction; their rollups, sources, baselines and
-- threshold overrides live apart from the outgoing ones so no outgoing query can mix them in.

ALTER TABLE events
  ADD COLUMN direction text NOT NULL DEFAULT 'outbound',
  ADD COLUMN sent_at timestamptz;

-- One row per (org, project, environment, provider, route template, minute). d0..d17: handler
-- duration histogram (ms buckets, packages/shared/src/histogram.ts); l0..l17: delivery lag
-- histogram, the same buckets in SECONDS (1 s … 18 h).
CREATE TABLE rollups_inbound_1m (
  org_id          text NOT NULL,
  project_id      text NOT NULL,
  environment     text NOT NULL,
  provider        text NOT NULL,
  endpoint        text NOT NULL,
  minute          timestamptz NOT NULL,
  total           integer NOT NULL DEFAULT 0,
  -- our app answered 2xx
  accepted        integer NOT NULL DEFAULT 0,
  -- everything else, including unanswered
  rejected        integer NOT NULL DEFAULT 0,
  status_3xx      integer NOT NULL DEFAULT 0,
  status_401      integer NOT NULL DEFAULT 0,
  status_403      integer NOT NULL DEFAULT 0,
  -- 4xx other than 401/403
  status_4xx      integer NOT NULL DEFAULT 0,
  status_5xx      integer NOT NULL DEFAULT 0,
  -- connection closed before our answer (the sender gave up)
  unanswered      integer NOT NULL DEFAULT 0,
  duration_sum_ms double precision NOT NULL DEFAULT 0,
  d0 integer NOT NULL DEFAULT 0,  d1 integer NOT NULL DEFAULT 0,  d2 integer NOT NULL DEFAULT 0,
  d3 integer NOT NULL DEFAULT 0,  d4 integer NOT NULL DEFAULT 0,  d5 integer NOT NULL DEFAULT 0,
  d6 integer NOT NULL DEFAULT 0,  d7 integer NOT NULL DEFAULT 0,  d8 integer NOT NULL DEFAULT 0,
  d9 integer NOT NULL DEFAULT 0,  d10 integer NOT NULL DEFAULT 0, d11 integer NOT NULL DEFAULT 0,
  d12 integer NOT NULL DEFAULT 0, d13 integer NOT NULL DEFAULT 0, d14 integer NOT NULL DEFAULT 0,
  d15 integer NOT NULL DEFAULT 0, d16 integer NOT NULL DEFAULT 0, d17 integer NOT NULL DEFAULT 0,
  -- deliveries that carried a send timestamp
  lag_count       integer NOT NULL DEFAULT 0,
  lag_sum_s       double precision NOT NULL DEFAULT 0,
  l0 integer NOT NULL DEFAULT 0,  l1 integer NOT NULL DEFAULT 0,  l2 integer NOT NULL DEFAULT 0,
  l3 integer NOT NULL DEFAULT 0,  l4 integer NOT NULL DEFAULT 0,  l5 integer NOT NULL DEFAULT 0,
  l6 integer NOT NULL DEFAULT 0,  l7 integer NOT NULL DEFAULT 0,  l8 integer NOT NULL DEFAULT 0,
  l9 integer NOT NULL DEFAULT 0,  l10 integer NOT NULL DEFAULT 0, l11 integer NOT NULL DEFAULT 0,
  l12 integer NOT NULL DEFAULT 0, l13 integer NOT NULL DEFAULT 0, l14 integer NOT NULL DEFAULT 0,
  l15 integer NOT NULL DEFAULT 0, l16 integer NOT NULL DEFAULT 0, l17 integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, project_id, environment, provider, endpoint, minute)
);
CREATE INDEX rollups_inbound_1m_minute_idx ON rollups_inbound_1m (org_id, project_id, minute);

-- One row per webhook source. last_delivery_at is moved forward at ingest (at most every 30 s
-- per source and collector); expected_quiet switches silence detection off for the source.
CREATE TABLE webhook_sources (
  org_id            text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id        text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment       text NOT NULL,
  provider          text NOT NULL,
  endpoint          text NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_delivery_at  timestamptz NOT NULL,
  last_service      text,
  expected_quiet    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, project_id, environment, provider, endpoint)
);

-- Cached per source, refreshed every 10 minutes: normal rejected share, handler and lag
-- percentiles (7 days, incident minutes excluded) and the silence profile (28 days, hours in
-- silence incidents excluded): hourly rate per hour of week, dispersion, history.
CREATE TABLE inbound_baselines (
  org_id           text NOT NULL,
  project_id       text NOT NULL,
  environment      text NOT NULL,
  provider         text NOT NULL,
  endpoint         text NOT NULL,
  rejection_rate   double precision NOT NULL,
  p50_ms           double precision,
  p95_ms           double precision,
  lag_p95_s        double precision,
  sample_size      bigint NOT NULL,
  history_minutes  integer NOT NULL,
  learning         boolean NOT NULL,
  silence          jsonb NOT NULL DEFAULT '{}',
  computed_at      timestamptz NOT NULL,
  PRIMARY KEY (org_id, project_id, environment, provider, endpoint)
);

ALTER TABLE providers
  ADD COLUMN webhook_thresholds jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN webhooks_public boolean NOT NULL DEFAULT false;

ALTER TABLE incidents ADD COLUMN direction text NOT NULL DEFAULT 'outbound'
  CHECK (direction IN ('outbound', 'inbound'));
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_kind_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_kind_check CHECK (
  kind IN ('errors', 'latency', 'auth', 'not_found', 'validation', 'rate_limited', 'behaviour',
           'webhook_silence', 'webhook_rejections', 'webhook_slow', 'webhook_lag')
);
CREATE INDEX incidents_direction_open_idx ON incidents (org_id, project_id, direction) WHERE status = 'open';
