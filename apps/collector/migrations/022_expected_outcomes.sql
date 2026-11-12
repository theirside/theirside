-- Expected outcomes (docs/scoring.md "Expected outcomes", docs/architecture.md §10, 2026-11-12):
-- 4xx answers that are normal business answers for an endpoint (a consent check answering 400).

-- In code (SDK markExpected / expecting): calls the app tagged, counted in `ok` and not in
-- http_4xx or the status columns; `expected` says how many of `ok` they are. Metadata-only
-- change (a constant default), no table rewrite.
ALTER TABLE rollups_1m ADD COLUMN expected integer NOT NULL DEFAULT 0;

-- The same calls per reason label, for the endpoint page's series. Small: one row per key,
-- minute and reason the app used (at most 10 reasons per key in one batch; more count as `other`).
CREATE TABLE rollups_expected_1m (
  org_id       text NOT NULL,
  project_id   text NOT NULL,
  environment  text NOT NULL,
  provider     text NOT NULL,
  endpoint     text NOT NULL,
  method       text NOT NULL,
  minute       timestamptz NOT NULL,
  reason       text NOT NULL,
  calls        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, project_id, environment, provider, endpoint, method, minute, reason)
);
CREATE INDEX rollups_expected_1m_minute_idx ON rollups_expected_1m (org_id, project_id, minute);

-- The reason on the raw event (NULL: not tagged); tagged calls are never failure samples.
ALTER TABLE events ADD COLUMN expected text;

-- From the dashboard: statuses marked expected per endpoint, `METHOD /template` → [400, …].
-- Applied when scoring (rollups keep the raw counts), with a safety net for a surge.
ALTER TABLE providers ADD COLUMN expected_statuses jsonb NOT NULL DEFAULT '{}';

-- Why an incident was resolved when it wasn't by recovery (marking a status expected).
ALTER TABLE incidents ADD COLUMN resolution_note text;
