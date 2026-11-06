-- Per-provider threshold overrides (minimum calls, bad minutes to open, error-rate and latency
-- rules); keys left out use the project's thresholds. Alerts on/off stays `alerts_enabled`.
ALTER TABLE providers ADD COLUMN thresholds jsonb NOT NULL DEFAULT '{}';
