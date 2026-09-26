CREATE TABLE DTM_contacts
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NOT NULL,
    location_id INT NULL,                            -- NULL = usable everywhere in the account
    name NVARCHAR(80) NOT NULL,
    email NVARCHAR(254) NULL,
    phone NVARCHAR(30) NULL,
    sms_opted_out BIT NOT NULL DEFAULT 0,
    created_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_contacts_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id),
    CONSTRAINT fk_DTM_contacts_locations FOREIGN KEY (location_id) REFERENCES DTM_locations (id)
);
CREATE UNIQUE INDEX ux_DTM_contacts_uid ON DTM_contacts (uid);

-- Escalation ladders are the only notification path (architecture 8.5).
CREATE TABLE DTM_alert_groups
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NOT NULL,
    name NVARCHAR(80) NOT NULL,
    is_default BIT NOT NULL DEFAULT 0,
    tag_query NVARCHAR(MAX) NULL,                    -- {any,all,none,text}; NULL = explicit attachment only
    created_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_alert_groups_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_alert_groups_uid ON DTM_alert_groups (uid);

CREATE TABLE DTM_alert_group_levels
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    alert_group_id INT NOT NULL,
    level_no TINYINT NOT NULL,
    wait_minutes INT NOT NULL DEFAULT 0,             -- delay before this level after the previous one
    CONSTRAINT fk_DTM_alert_group_levels_groups FOREIGN KEY (alert_group_id) REFERENCES DTM_alert_groups (id)
);
CREATE UNIQUE INDEX ux_DTM_alert_group_levels ON DTM_alert_group_levels (alert_group_id, level_no);

CREATE TABLE DTM_alert_group_recipients
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    level_id INT NOT NULL,
    recipient_type NVARCHAR(12) NOT NULL,            -- user | contact | all_access
    recipient_id INT NULL,
    CONSTRAINT fk_DTM_alert_group_recipients_levels FOREIGN KEY (level_id) REFERENCES DTM_alert_group_levels (id)
);
CREATE INDEX ix_DTM_alert_group_recipients_level ON DTM_alert_group_recipients (level_id);

-- Threshold rules and no_data rules share a table; threshold columns are NULL for no_data.
CREATE TABLE DTM_alarm_rules
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    sensor_id INT NOT NULL,
    rule_kind NVARCHAR(10) NOT NULL,                 -- threshold | no_data
    direction NVARCHAR(5) NULL,                      -- upper | lower
    threshold FLOAT NULL,                            -- canonical units
    severity NVARCHAR(10) NOT NULL DEFAULT 'alarm',  -- info | warning | alarm | emergency
    exceed_secs INT NOT NULL DEFAULT 0,
    return_secs INT NOT NULL DEFAULT 0,
    timeout_secs INT NULL,                           -- no_data only
    is_enabled BIT NOT NULL DEFAULT 1,
    use_default_group BIT NOT NULL DEFAULT 1,
    channel_policy NVARCHAR(400) NULL,               -- per transition x channel JSON; NULL = all on
    breach_since BIGINT NULL,
    return_since BIGINT NULL,
    created_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_alarm_rules_sensors FOREIGN KEY (sensor_id) REFERENCES DTM_sensors (id)
);
CREATE UNIQUE INDEX ux_DTM_alarm_rules_uid ON DTM_alarm_rules (uid);
CREATE INDEX ix_DTM_alarm_rules_sensor_live ON DTM_alarm_rules (sensor_id) WHERE delete_epoch IS NULL;

CREATE TABLE DTM_alarm_rule_alert_groups
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    alarm_rule_id INT NOT NULL,
    alert_group_id INT NOT NULL,
    CONSTRAINT fk_DTM_alarm_rule_alert_groups_rules FOREIGN KEY (alarm_rule_id) REFERENCES DTM_alarm_rules (id),
    CONSTRAINT fk_DTM_alarm_rule_alert_groups_groups FOREIGN KEY (alert_group_id) REFERENCES DTM_alert_groups (id)
);
CREATE UNIQUE INDEX ux_DTM_alarm_rule_alert_groups ON DTM_alarm_rule_alert_groups (alarm_rule_id, alert_group_id);

-- One active alarm per sensor per direction; cleared rows stay as history (architecture 8.2).
CREATE TABLE DTM_alarms
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    sensor_id INT NOT NULL,
    direction NVARCHAR(7) NOT NULL,                  -- upper | lower | no_data
    severity NVARCHAR(10) NOT NULL,
    rule_id INT NULL,                                -- rule that set the current severity
    raised_epoch BIGINT NOT NULL,
    cleared_epoch BIGINT NULL,
    clear_reason NVARCHAR(40) NULL,                  -- returned | manual | offline | disarmed | archived
    acked_by INT NULL,
    acked_epoch BIGINT NULL,
    ack_until_epoch BIGINT NULL,
    last_notified_epoch BIGINT NULL,
    suppressed_by INT NULL,                          -- gateway alarm id (architecture 8.4)
    trigger_value FLOAT NULL,
    CONSTRAINT fk_DTM_alarms_sensors FOREIGN KEY (sensor_id) REFERENCES DTM_sensors (id)
);
CREATE UNIQUE INDEX ux_DTM_alarms_uid ON DTM_alarms (uid);
CREATE UNIQUE INDEX ux_DTM_alarms_active ON DTM_alarms (sensor_id, direction) WHERE cleared_epoch IS NULL;
CREATE INDEX ix_DTM_alarms_sensor_history ON DTM_alarms (sensor_id, raised_epoch);

CREATE TABLE DTM_alarm_events
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    alarm_id INT NOT NULL,
    epoch BIGINT NOT NULL,
    event_kind NVARCHAR(14) NOT NULL,                -- raised | escalated | de_escalated | acknowledged | ignored | cleared | re_notified | suppressed
    severity NVARCHAR(10) NULL,
    value FLOAT NULL,
    actor_type NVARCHAR(14) NULL,                    -- user | api_credential | system
    actor_id INT NULL,
    comment NVARCHAR(500) NULL,
    CONSTRAINT fk_DTM_alarm_events_alarms FOREIGN KEY (alarm_id) REFERENCES DTM_alarms (id)
);
CREATE INDEX ix_DTM_alarm_events_alarm ON DTM_alarm_events (alarm_id, epoch);

CREATE TABLE DTM_alarm_escalations
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    alarm_id INT NOT NULL,
    alert_group_id INT NOT NULL,
    current_level TINYINT NOT NULL DEFAULT 1,
    level_entered_epoch BIGINT NOT NULL,
    is_stopped BIT NOT NULL DEFAULT 0,
    CONSTRAINT fk_DTM_alarm_escalations_alarms FOREIGN KEY (alarm_id) REFERENCES DTM_alarms (id),
    CONSTRAINT fk_DTM_alarm_escalations_groups FOREIGN KEY (alert_group_id) REFERENCES DTM_alert_groups (id)
);
CREATE UNIQUE INDEX ux_DTM_alarm_escalations ON DTM_alarm_escalations (alarm_id, alert_group_id);

-- Recurring disarm windows, evaluated in the location timezone (architecture 8.3).
CREATE TABLE DTM_alarm_schedules
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NOT NULL,
    name NVARCHAR(80) NOT NULL,
    dow_mask TINYINT NOT NULL,                       -- bit 0 = Sunday
    start_minute SMALLINT NOT NULL,
    end_minute SMALLINT NOT NULL,                    -- end < start crosses midnight
    created_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_alarm_schedules_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_alarm_schedules_uid ON DTM_alarm_schedules (uid);

CREATE TABLE DTM_alarm_schedule_links
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    schedule_id INT NOT NULL,
    entity_type NVARCHAR(6) NOT NULL,                -- device | rule
    entity_id INT NOT NULL,
    CONSTRAINT fk_DTM_alarm_schedule_links_schedules FOREIGN KEY (schedule_id) REFERENCES DTM_alarm_schedules (id)
);
CREATE UNIQUE INDEX ux_DTM_alarm_schedule_links ON DTM_alarm_schedule_links (schedule_id, entity_type, entity_id);

CREATE TABLE DTM_offline_periods
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    device_id INT NOT NULL,
    start_epoch BIGINT NOT NULL,
    end_epoch BIGINT NULL,                           -- NULL = open ended
    reason NVARCHAR(120) NOT NULL,
    comment NVARCHAR(500) NOT NULL,
    created_by INT NOT NULL,
    created_epoch BIGINT NOT NULL,
    CONSTRAINT fk_DTM_offline_periods_devices FOREIGN KEY (device_id) REFERENCES DTM_devices (id)
);
CREATE INDEX ix_DTM_offline_periods_device ON DTM_offline_periods (device_id, start_epoch);
