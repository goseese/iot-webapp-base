CREATE TABLE DTM_activity_log
(
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    epoch BIGINT NOT NULL,
    actor_type NVARCHAR(14) NULL,                    -- user | api_credential | anonymous
    actor_id INT NULL,
    actor_name NVARCHAR(80) NULL,
    action NVARCHAR(40) NOT NULL,
    entity_type NVARCHAR(16) NULL,
    entity_uid UNIQUEIDENTIFIER NULL,
    ip NVARCHAR(45) NULL,
    user_agent NVARCHAR(300) NULL,
    outcome NVARCHAR(10) NOT NULL DEFAULT 'ok',      -- ok | denied | failed
    detail NVARCHAR(500) NULL
);
CREATE INDEX ix_DTM_activity_log_epoch ON DTM_activity_log (epoch);
CREATE INDEX ix_DTM_activity_log_login ON DTM_activity_log (action, actor_name, epoch);
CREATE INDEX ix_DTM_activity_log_ip ON DTM_activity_log (action, ip, epoch);

-- Permanent, append only. The app login gets INSERT and SELECT only (architecture 13).
CREATE TABLE DTM_audit_log
(
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    epoch BIGINT NOT NULL,
    entity_type NVARCHAR(16) NOT NULL,
    entity_uid UNIQUEIDENTIFIER NOT NULL,
    entity_name NVARCHAR(120) NULL,
    field NVARCHAR(60) NOT NULL,
    old_value NVARCHAR(MAX) NULL,
    new_value NVARCHAR(MAX) NULL,
    actor_type NVARCHAR(14) NOT NULL,
    actor_id INT NULL,
    actor_name NVARCHAR(80) NULL
);
CREATE INDEX ix_DTM_audit_log_entity ON DTM_audit_log (entity_type, entity_uid, epoch);

CREATE TABLE DTM_webhooks
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NOT NULL,
    name NVARCHAR(80) NOT NULL,
    url NVARCHAR(500) NOT NULL,
    signing_secret_enc NVARCHAR(400) NOT NULL,
    event_types NVARCHAR(400) NOT NULL,              -- comma list: reading, alarm, status
    is_enabled BIT NOT NULL DEFAULT 1,
    created_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_webhooks_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_webhooks_uid ON DTM_webhooks (uid);

CREATE TABLE DTM_webhook_deliveries
(
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    webhook_id INT NOT NULL,
    epoch BIGINT NOT NULL,
    event_type NVARCHAR(16) NOT NULL,
    payload NVARCHAR(MAX) NOT NULL,
    attempts TINYINT NOT NULL DEFAULT 0,
    next_attempt_epoch BIGINT NULL,
    status_code SMALLINT NULL,
    outcome NVARCHAR(10) NOT NULL DEFAULT 'pending', -- pending | sent | failed
    CONSTRAINT fk_DTM_webhook_deliveries_webhooks FOREIGN KEY (webhook_id) REFERENCES DTM_webhooks (id)
);
CREATE INDEX ix_DTM_webhook_deliveries_pending ON DTM_webhook_deliveries (next_attempt_epoch) WHERE outcome = 'pending';
