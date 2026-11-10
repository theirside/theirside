-- Zero-config first start (no THEIRSIDE_BOOTSTRAP_API_KEY, no THEIRSIDE_ADMIN_TOKEN): the collector
-- generates the project's first API key itself. Nobody has seen it yet, so it is kept readable for
-- admins (the "Connect your app" screen and Settings → API keys) instead of only as a hash. Every
-- other key stays hash-only and is shown once at creation. Cleared when the key is revoked.
ALTER TABLE api_keys ADD COLUMN visible_key text;
