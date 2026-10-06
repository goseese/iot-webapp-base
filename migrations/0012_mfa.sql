-- MFA sign in codes (DECISIONS.md "MFA sign in codes"). Site settings MFA_ENABLED and
-- MFA_CODE_MINUTES decide who needs a code; these columns are the per user override and channel.
--   mfa_mode: NULL inherits the site setting (everyone, by default), 'on' or 'off'. Superadmin only.
--   mfa_channel: where the code goes. SMS is hidden in this app, so every user stays on 'email'
--   until SMS is turned on; the column is here so that needs no migration.
-- A non volatile DEFAULT on ADD COLUMN fills existing rows (PostgreSQL 11+), so no UPDATE.
ALTER TABLE users ADD COLUMN mfa_mode VARCHAR(3) NULL CHECK (mfa_mode IN ('on', 'off'));
ALTER TABLE users ADD COLUMN mfa_channel VARCHAR(5) NOT NULL DEFAULT 'email' CHECK (mfa_channel IN ('email', 'sms'));
