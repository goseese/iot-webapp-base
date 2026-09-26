-- Every send decision writes here first; "why didn't I get it" is a query (architecture 8.6).
CREATE TABLE DTM_notifications
(
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    epoch BIGINT NOT NULL,
    kind NVARCHAR(16) NOT NULL,                      -- alarm | invite | reset | report | test | system
    channel NVARCHAR(5) NOT NULL,                    -- email | sms
    recipient_type NVARCHAR(8) NOT NULL,             -- user | contact | address
    recipient_id INT NULL,
    address NVARCHAR(254) NOT NULL,
    alarm_event_id INT NULL,
    report_run_id INT NULL,
    ladder_note NVARCHAR(80) NULL,                   -- "level 2 of Night crew"
    outcome NVARCHAR(10) NOT NULL,                   -- sent | failed | suppressed
    reason NVARCHAR(200) NULL,
    provider NVARCHAR(16) NULL,
    provider_message_id NVARCHAR(120) NULL,
    subject NVARCHAR(200) NULL
);
CREATE INDEX ix_DTM_notifications_epoch ON DTM_notifications (epoch);
CREATE INDEX ix_DTM_notifications_alarm_event ON DTM_notifications (alarm_event_id);
CREATE INDEX ix_DTM_notifications_recipient ON DTM_notifications (recipient_type, recipient_id, epoch);

CREATE TABLE DTM_user_notification_prefs
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    user_id INT NOT NULL,
    scope_type NVARCHAR(8) NOT NULL,                 -- global | account | location
    scope_id INT NULL,
    channel NVARCHAR(5) NOT NULL,
    enabled NVARCHAR(7) NOT NULL DEFAULT 'inherit',  -- on | off | inherit
    min_severity_raise NVARCHAR(10) NULL,
    min_severity_clear NVARCHAR(10) NULL,
    tag_query NVARCHAR(MAX) NULL,
    CONSTRAINT fk_DTM_user_notification_prefs_users FOREIGN KEY (user_id) REFERENCES DTM_users (id)
);
CREATE UNIQUE INDEX ux_DTM_user_notification_prefs ON DTM_user_notification_prefs (user_id, scope_type, scope_id, channel);
