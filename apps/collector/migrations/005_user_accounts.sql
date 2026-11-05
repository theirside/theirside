-- Built-in user accounts (docs/architecture.md §4): passwords, server-side sessions,
-- invite and password-reset links, login throttling. Every secret is stored as a hash:
-- passwords argon2id, session/invite/reset tokens SHA-256 (they are 256-bit random).

-- auth_source: 'password' (email + password; NULL password_hash = no sign-in yet, e.g.
-- the placeholder admin older bootstraps created), 'proxy' (identity from a trusted
-- proxy), 'system' (the THEIRSIDE_ADMIN_TOKEN break-glass principal; never listed).
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN auth_source text NOT NULL DEFAULT 'password'
  CHECK (auth_source IN ('password', 'proxy', 'system'));
ALTER TABLE users ADD COLUMN last_login_at timestamptz;

-- id_hash = SHA-256 of the cookie token; the token itself is never stored.
CREATE TABLE sessions (
  id_hash       text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- One-time links: 'invite' (email, 7 days), 'reset' (user, 1 hour), 'mfa' (second
-- login step, 5 minutes). token_hash = SHA-256 of the token in the link.
CREATE TABLE auth_tokens (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('invite', 'reset', 'mfa')),
  token_hash  text NOT NULL UNIQUE,
  org_id      text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     text REFERENCES users(id) ON DELETE CASCADE,
  email       text,
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX auth_tokens_org_kind_idx ON auth_tokens (org_id, kind);

-- Failed sign-in attempts per key ('account:<email>', 'ip:<address>', ...), shared by
-- all replicas. failures counts within the window starting at window_start.
CREATE TABLE auth_throttle (
  key           text PRIMARY KEY,
  failures      integer NOT NULL,
  window_start  timestamptz NOT NULL,
  locked_until  timestamptz
);
