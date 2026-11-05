-- Alert state on incidents (Phase 3).
-- alerts_muted: opened inside the 30-minute cooldown of a previous incident on the
--   same endpoint; tracked and shown, but no open/escalation/resolve alerts.
-- last_alerted_p95_ms: latency escalation reference, like last_alerted_rate.
-- last_evaluated_minute: the minute the engine last processed (idempotent ticks).
ALTER TABLE incidents ADD COLUMN alerts_muted boolean NOT NULL DEFAULT false;
ALTER TABLE incidents ADD COLUMN last_alerted_p95_ms double precision;
ALTER TABLE incidents ADD COLUMN last_evaluated_minute timestamptz;
