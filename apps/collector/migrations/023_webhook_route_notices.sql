-- Discovered webhook routes on the Webhooks page and in alert channels (docs/architecture.md §10,
-- 2026-11-13): a one-time "new webhook route discovered" message per route, switchable per project.

-- When the route was in a notice (NULL: not yet). Routes from before this migration count as
-- notified, so an upgrade doesn't announce every route at once.
ALTER TABLE webhook_candidates ADD COLUMN notified_at timestamptz;
UPDATE webhook_candidates SET notified_at = now();

-- Settings → Providers: send that message (on by default, like the new-providers digest).
ALTER TABLE settings ADD COLUMN webhook_route_notices boolean NOT NULL DEFAULT true;
