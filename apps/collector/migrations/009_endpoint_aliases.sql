-- Endpoint templates merged into a more specific one ("METHOD /old/template" → "/new/template"),
-- per provider: ingest rewrites them, so SDKs that still send the old template (until
-- they pick up the pushed routes) don't bring the merged row back.
ALTER TABLE providers ADD COLUMN endpoint_aliases jsonb NOT NULL DEFAULT '{}';
