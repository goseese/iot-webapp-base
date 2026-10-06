-- Alarm titles (ALARM_TITLES_AND_RULE_LOG_README.md Part A). One line per alarm: the email subject
-- after the event word, the first line of the SMS and the API alarm name. Levels without a scoped
-- settings table store their template here; NULL inherits the next level up. Location and account
-- titles are ALARM_TITLE_FORMAT rows in location_settings and account_settings, the site default is
-- the ALARM_TITLE_FORMAT site setting (seeds/0001_site_settings.js).
ALTER TABLE alarm_rules ADD COLUMN alarm_title VARCHAR(200) NULL;
ALTER TABLE sensors ADD COLUMN alarm_title VARCHAR(200) NULL;
ALTER TABLE devices ADD COLUMN alarm_title VARCHAR(200) NULL;

-- The stored subject is the event word plus the title, up to 224 characters
-- ("ESCALATED to emergency: " + 200). Widening a VARCHAR does not rewrite the table.
ALTER TABLE notifications ALTER COLUMN subject TYPE VARCHAR(255);

-- Alarm rule change log (Part B) reads audit_log by entity_type and time across every rule
-- (GET /alarm-rules/changes). audit_log is permanent, so index that scan now.
CREATE INDEX ix_audit_log_type_epoch ON audit_log (entity_type, epoch);
