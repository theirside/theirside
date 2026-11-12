-- Webhook discovery (docs/architecture.md §10, 2026-11-10). Routes the SDK reports as candidate
-- webhook deliveries from senders it can't identify. They are never scored: no rollups, sources or
-- incidents until an admin confirms the route with a name (then the SDK records it like a declared
-- route), and a member may ignore one (the SDK stops reporting it).
CREATE TABLE webhook_candidates (
  org_id          text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- the route template as the SDK sent it (strict path privacy; the suggested name kept literal)
  endpoint        text NOT NULL,
  method          text NOT NULL,
  -- the name the SDK suggested from the path (NULL: none, the SDK sent "unknown")
  suggested_name  text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'ignored')),
  -- confirmed: the provider name the admin gave
  provider        text,
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  last_service    text,
  decided_at      timestamptz,
  decided_by      text,
  PRIMARY KEY (org_id, project_id, endpoint),
  CHECK (status <> 'confirmed' OR provider IS NOT NULL)
);
CREATE INDEX webhook_candidates_status_idx ON webhook_candidates (org_id, project_id, status);

-- Deliveries per candidate route and UTC day (the SDK reports each route once a minute with a count).
CREATE TABLE webhook_candidate_days (
  org_id      text NOT NULL,
  project_id  text NOT NULL,
  endpoint    text NOT NULL,
  day         date NOT NULL,
  deliveries  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, project_id, endpoint, day),
  FOREIGN KEY (org_id, project_id, endpoint)
    REFERENCES webhook_candidates (org_id, project_id, endpoint) ON DELETE CASCADE
);
