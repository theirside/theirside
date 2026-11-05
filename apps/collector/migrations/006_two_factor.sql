-- Optional TOTP two-factor sign-in (docs/architecture.md §4).
-- TOTP secrets are encrypted with a key derived from THEIRSIDE_SECRET_KEY (AES-256-GCM,
-- format v1.<key id>.<iv>.<ciphertext>.<tag>); pending = enrolment not yet confirmed.
-- totp_last_step: the last accepted 30-second step, so a code is accepted only once.
ALTER TABLE users ADD COLUMN totp_secret_enc text;
ALTER TABLE users ADD COLUMN totp_pending_enc text;
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_last_step bigint;

-- Single-use recovery codes, SHA-256 of the normalized code (~78 bits of entropy each).
CREATE TABLE user_recovery_codes (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  created_at  timestamptz NOT NULL,
  used_at     timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- Every user of the org must use 2FA (password sign-ins; proxy sign-ins rely on the IdP).
ALTER TABLE orgs ADD COLUMN require_2fa boolean NOT NULL DEFAULT false;
