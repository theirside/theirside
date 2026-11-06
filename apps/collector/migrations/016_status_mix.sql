-- Behaviour-change detection: an endpoint's status mix, not only its 5xx and network errors.
-- Rollups count 3xx and the common 4xx one by one (429 already was); the rest of 4xx stays in
-- http_4xx. Baselines keep the normal share of each group (auth, not found, validation, other
-- 4xx); incidents get their own kinds and the deploy/restart hint shown in alerts.
ALTER TABLE rollups_1m
  ADD COLUMN status_3xx integer NOT NULL DEFAULT 0,
  ADD COLUMN status_400 integer NOT NULL DEFAULT 0,
  ADD COLUMN status_401 integer NOT NULL DEFAULT 0,
  ADD COLUMN status_403 integer NOT NULL DEFAULT 0,
  ADD COLUMN status_404 integer NOT NULL DEFAULT 0,
  ADD COLUMN status_409 integer NOT NULL DEFAULT 0,
  ADD COLUMN status_422 integer NOT NULL DEFAULT 0;

ALTER TABLE baselines ADD COLUMN status_mix jsonb NOT NULL DEFAULT '{}';

ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_kind_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_kind_check CHECK (
  kind IN ('errors', 'latency', 'auth', 'not_found', 'validation', 'rate_limited', 'behaviour')
);
ALTER TABLE incidents ADD COLUMN deploy_hint text;

-- Rollups written before this have no per-status counts (their 4xx would all look like "other
-- 4xx"), so baselines take the status mix only from minutes after this moment, and 4xx groups
-- aren't judged until a day of it exists.
INSERT INTO install_meta (key, value)
VALUES ('status_mix_since', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;
