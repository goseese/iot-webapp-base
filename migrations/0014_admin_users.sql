-- Administration > Users (DECISIONS.md "Administration > Users").
--   disabled_epoch: set when a superadmin puts the user offline; NULL is online. An offline user
--   cannot sign in (password, sign in code, reset link) and loses any open session. Alarm email
--   still follows email_enabled, so offline is about signing in only.
--   disabled_by: the users.id of the superadmin who put them offline, for the detail page.
--   chart_email_limit_once and chart_email_limit_once_until: a one time chart email limit that
--   replaces the user's normal limit until the epoch, then lapses on its own. Both set or both NULL.
ALTER TABLE users ADD COLUMN disabled_epoch BIGINT NULL;
ALTER TABLE users ADD COLUMN disabled_by INTEGER NULL;
ALTER TABLE users ADD COLUMN chart_email_limit_once INTEGER NULL CHECK (chart_email_limit_once >= 0);
ALTER TABLE users ADD COLUMN chart_email_limit_once_until BIGINT NULL;
ALTER TABLE users ADD CONSTRAINT ck_users_chart_email_limit_once
    CHECK ((chart_email_limit_once IS NULL) = (chart_email_limit_once_until IS NULL));
