-- One row per SDK process (SDK 0.2.0+ sends a random instance id and its start time): how
-- many processes a service runs, restarts and deploys (a new start time or SDK version), and
-- short-lived ones (serverless). Pruned 7 days after last seen.
CREATE TABLE sdk_processes (
  org_id          text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service         text NOT NULL,
  environment     text NOT NULL,
  instance_id     text NOT NULL,
  started_at      timestamptz NOT NULL,
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  -- last batch that carried calls (heartbeats don't count)
  last_event_at   timestamptz,
  sdk_version     text NOT NULL,
  runtime         text,
  runtime_version text,
  platform        text,
  serverless      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, project_id, service, environment, instance_id)
);
CREATE INDEX sdk_processes_seen_idx ON sdk_processes (org_id, project_id, last_seen_at);

-- The service row: last batch with calls (vs any batch, heartbeats included), and how it runs.
ALTER TABLE sdk_instances ADD COLUMN last_event_at timestamptz;
ALTER TABLE sdk_instances ADD COLUMN serverless boolean NOT NULL DEFAULT false;
ALTER TABLE sdk_instances ADD COLUMN platform text;
UPDATE sdk_instances SET last_event_at = last_seen_at;
