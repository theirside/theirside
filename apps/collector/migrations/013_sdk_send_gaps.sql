-- How regularly a service sends calls: a running average of the time between batches with
-- calls, and how many there were. SDK health warns about a short-lived service (functions,
-- cron) only when it was regular and has been silent for far longer than its usual gap.
ALTER TABLE sdk_instances ADD COLUMN event_gap_seconds double precision;
ALTER TABLE sdk_instances ADD COLUMN event_batches bigint NOT NULL DEFAULT 0;
