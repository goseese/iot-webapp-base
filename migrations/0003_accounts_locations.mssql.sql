-- Tenancy root. mqtt_* columns are the per account read only broker user for acct/{uid}/#.
CREATE TABLE DTM_accounts
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    name NVARCHAR(120) NOT NULL,
    is_enabled BIT NOT NULL DEFAULT 1,
    notifications_muted BIT NOT NULL DEFAULT 0,      -- account kill switch (architecture 8.6 gate 1)
    mqtt_enabled BIT NOT NULL DEFAULT 0,
    mqtt_username NVARCHAR(80) NULL,
    mqtt_password_enc NVARCHAR(400) NULL,
    created_epoch BIGINT NOT NULL,
    created_by INT NULL,
    delete_epoch BIGINT NULL
);
CREATE UNIQUE INDEX ux_DTM_accounts_uid ON DTM_accounts (uid);
CREATE INDEX ix_DTM_accounts_live ON DTM_accounts (name) WHERE delete_epoch IS NULL;

CREATE TABLE DTM_locations
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NOT NULL,
    name NVARCHAR(120) NOT NULL,
    iana_timezone NVARCHAR(64) NOT NULL DEFAULT 'UTC',
    address NVARCHAR(300) NULL,
    lat FLOAT NULL,
    lng FLOAT NULL,
    membership_mode NVARCHAR(10) NOT NULL DEFAULT 'normal', -- locked | normal | release (architecture 3.7)
    notifications_muted BIT NOT NULL DEFAULT 0,
    notes NVARCHAR(MAX) NULL,
    created_epoch BIGINT NOT NULL,
    created_by INT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_locations_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_locations_uid ON DTM_locations (uid);
CREATE INDEX ix_DTM_locations_account_live ON DTM_locations (account_id, name) WHERE delete_epoch IS NULL;
