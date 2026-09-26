-- Site scope settings. Account and location scopes arrive with their entities in step 3.
-- setting_key/setting_value instead of key/value: both are reserved words in T-SQL.
CREATE TABLE DTM_settings
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    setting_key NVARCHAR(80) NOT NULL,
    setting_value NVARCHAR(MAX) NULL,
    kind NVARCHAR(10) NOT NULL,            -- int | bool | string | secret
    description NVARCHAR(500) NOT NULL,
    min_value INT NULL,
    max_value INT NULL,
    needs_restart BIT NOT NULL DEFAULT 0,
    updated_epoch BIGINT NULL,
    updated_by INT NULL
);
CREATE UNIQUE INDEX ux_DTM_settings_key ON DTM_settings (setting_key);
