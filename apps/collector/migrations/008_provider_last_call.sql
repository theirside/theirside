-- When a provider was last called, kept on the provider row by ingest, so the providers
-- list shows a quiet provider as idle ("last call 3 days ago") without reading rollups.
ALTER TABLE providers ADD COLUMN last_call_at timestamptz;

-- Existing installs: the latest rollup minute (to the minute; ingest refines it).
UPDATE providers p SET last_call_at = r.last_minute
  FROM (SELECT org_id, project_id, provider, max(minute) AS last_minute
          FROM rollups_1m GROUP BY org_id, project_id, provider) r
 WHERE r.org_id = p.org_id AND r.project_id = p.project_id AND r.provider = p.name;
