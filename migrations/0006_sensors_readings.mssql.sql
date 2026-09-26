CREATE TABLE DTM_sensors
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    device_id INT NOT NULL,
    channel_id NVARCHAR(40) NOT NULL,
    name NVARCHAR(120) NOT NULL,
    metric NVARCHAR(40) NOT NULL,                    -- metrics/<slug>.js
    is_derived BIT NOT NULL DEFAULT 0,
    display_unit NVARCHAR(16) NULL,                  -- NULL = inherit
    display_precision TINYINT NULL,                  -- NULL = inherit
    retention_days INT NULL,                         -- NULL = inherit, -1 = forever
    formula_slug NVARCHAR(40) NULL,
    formula_params NVARCHAR(MAX) NULL,
    formula_inputs NVARCHAR(MAX) NULL,               -- JSON array of sensor uids
    carried_state NVARCHAR(MAX) NULL,
    last_value FLOAT NULL,
    last_epoch BIGINT NULL,
    last_reading_id BIGINT NULL,                     -- no FK: the reading may be purged
    is_enabled BIT NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    created_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_sensors_devices FOREIGN KEY (device_id) REFERENCES DTM_devices (id)
);
CREATE UNIQUE INDEX ux_DTM_sensors_uid ON DTM_sensors (uid);
CREATE UNIQUE INDEX ux_DTM_sensors_channel ON DTM_sensors (device_id, channel_id) WHERE delete_epoch IS NULL;

-- Pure time series: serial id only, canonical units only, retention by window (architecture 3.6).
CREATE TABLE DTM_readings
(
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    sensor_id INT NOT NULL,
    epoch BIGINT NOT NULL,
    value FLOAT NOT NULL,
    gateway_id INT NULL,
    rssi SMALLINT NULL
);
CREATE INDEX ix_DTM_readings_sensor_epoch ON DTM_readings (sensor_id, epoch);

-- Cross gateway dedup arbiter: the unique index is the claim (architecture 7.4).
CREATE TABLE DTM_device_frames
(
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    device_id INT NOT NULL,
    frame_counter BIGINT NOT NULL,
    epoch BIGINT NOT NULL
);
CREATE UNIQUE INDEX ux_DTM_device_frames ON DTM_device_frames (device_id, frame_counter);
CREATE INDEX ix_DTM_device_frames_epoch ON DTM_device_frames (epoch);

-- Optional raw capture for parser debugging, RAW_PUBLISH_LOG_DAYS > 0 (architecture 7.6).
CREATE TABLE DTM_raw_publish_log
(
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    epoch BIGINT NOT NULL,
    topic NVARCHAR(200) NOT NULL,
    payload VARBINARY(MAX) NOT NULL
);
CREATE INDEX ix_DTM_raw_publish_log_epoch ON DTM_raw_publish_log (epoch);

-- Asset slots bound to real sensors in the same location (architecture 3.4).
CREATE TABLE DTM_asset_inputs
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    asset_device_id INT NOT NULL,
    slot NVARCHAR(40) NOT NULL,
    source_sensor_id INT NULL,
    is_broken BIT NOT NULL DEFAULT 0,
    CONSTRAINT fk_DTM_asset_inputs_devices FOREIGN KEY (asset_device_id) REFERENCES DTM_devices (id),
    CONSTRAINT fk_DTM_asset_inputs_sensors FOREIGN KEY (source_sensor_id) REFERENCES DTM_sensors (id)
);
CREATE UNIQUE INDEX ux_DTM_asset_inputs_slot ON DTM_asset_inputs (asset_device_id, slot);
