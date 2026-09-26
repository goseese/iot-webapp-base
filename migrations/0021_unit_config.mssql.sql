-- Gateway configuration, one row per unit (MAC) and config key.
--
-- Config belongs to the hardware, like its broker credentials (migration 0020), so rows are keyed
-- by MAC and follow the unit across placements.
--
--   reported_*  what the unit last published on dev/{guid}/config/{key} (on every connect, and as
--               the reply to a write).
--   desired_*   a write from the config page that the unit has not confirmed yet. NULL when
--               nothing is pending. Ingest clears it when the unit reports the same value
--               (compared after normalizing by the key's type, services/unitConfig.js).
--   sent_epoch  when the write was last published to dev/{guid}/cmd/set_config/{key}. Writes are
--               not retained: ingest re-sends every pending key when the unit connects.
CREATE TABLE DTM_unit_config
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    mac CHAR(12) NOT NULL,
    config_key NVARCHAR(64) NOT NULL,
    reported_value NVARCHAR(255) NULL,
    reported_epoch BIGINT NULL,
    desired_value NVARCHAR(255) NULL,
    desired_epoch BIGINT NULL,
    desired_by INT NULL,
    sent_epoch BIGINT NULL
);
GO
CREATE UNIQUE INDEX ux_DTM_unit_config_key ON DTM_unit_config (mac, config_key);
GO
