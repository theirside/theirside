-- Path privacy per provider (docs/privacy.md), pushed to the SDK through /v1/sdk-config.
-- path_privacy: 'strict' or 'balanced' set in the dashboard; NULL = the SDK's own
--   `pathPrivacy` option (default strict).
-- allowed_path_words: extra words the SDK may send as-is in strict mode (lower-case).
ALTER TABLE providers ADD COLUMN path_privacy text
  CHECK (path_privacy IN ('strict', 'balanced'));
ALTER TABLE providers ADD COLUMN allowed_path_words text[] NOT NULL DEFAULT '{}';
