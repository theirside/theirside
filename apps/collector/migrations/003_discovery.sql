-- Auto-discovery (docs/architecture.md §5): providers found from traffic.
-- source: configured (init() / dashboard), discovered (registrable domain), catalog (known provider).
-- hosts: exact hosts seen for the provider (capped; tenant-style subdomains fold into
--   a `*.domain` entry in host_patterns).
-- domain: the domain the provider is keyed on (catalog or registrable domain).
-- hidden: stop collecting (pushed to the SDK); internal: the team's own service, never
--   collected. alerts_enabled: incidents are tracked but not alerted when false
--   (default false for infrastructure). display_name: dashboard rename; `name` stays
--   the key rollups and incidents are stored under. digest_notified_at: included in a
--   "new providers discovered" digest.
ALTER TABLE providers ADD COLUMN source text NOT NULL DEFAULT 'configured'
  CHECK (source IN ('configured', 'discovered', 'catalog'));
ALTER TABLE providers ADD COLUMN category text;
ALTER TABLE providers ADD COLUMN hosts text[] NOT NULL DEFAULT '{}';
ALTER TABLE providers ADD COLUMN domain text;
ALTER TABLE providers ADD COLUMN hidden boolean NOT NULL DEFAULT false;
ALTER TABLE providers ADD COLUMN internal boolean NOT NULL DEFAULT false;
ALTER TABLE providers ADD COLUMN alerts_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE providers ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE providers ADD COLUMN display_name text;
ALTER TABLE providers ADD COLUMN digest_notified_at timestamptz;
UPDATE providers SET first_seen_at = created_at, digest_notified_at = created_at;

-- Discovery digest to alert channels (at most hourly); on by default.
ALTER TABLE settings ADD COLUMN discovery_digest boolean NOT NULL DEFAULT true;
