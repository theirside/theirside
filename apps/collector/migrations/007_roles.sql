-- Two fixed roles in the free edition: admin (everything) and member (view, providers,
-- own account). Every existing user was equal and could do everything: they become
-- admins, and so do pending invites created under that rule.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
UPDATE memberships SET role = 'admin';
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('admin', 'member'));

-- The role an invite grants.
ALTER TABLE auth_tokens ADD COLUMN role text CHECK (role IN ('admin', 'member'));
UPDATE auth_tokens SET role = 'admin' WHERE kind = 'invite';
