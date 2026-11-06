-- Pooled learning (SDK 0.2.0): the templates each service sends, per provider and host, so the
-- collector can count distinct literal path words across all of a service's processes and send
-- the positions that are IDs back to that service's SDKs. Written at ingest only for templates
-- not seen recently; pruned 7 days after last seen.
CREATE TABLE service_templates (
  org_id       text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service      text NOT NULL,
  environment  text NOT NULL,
  provider     text NOT NULL,
  host         text NOT NULL,
  method       text NOT NULL,
  endpoint     text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, project_id, service, environment, provider, host, method, endpoint)
);
CREATE INDEX service_templates_seen_idx ON service_templates (last_seen_at);
