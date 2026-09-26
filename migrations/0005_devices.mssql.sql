-- Shadow of deviceTypes/*.js; upserted at boot, never edited by hand (conventions.md section 3).
CREATE TABLE DTM_device_types
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    slug NVARCHAR(40) NOT NULL,
    display_name NVARCHAR(80) NOT NULL,
    kind NVARCHAR(8) NOT NULL,                       -- gateway | node | beacon | direct | asset
    dedup_mode NVARCHAR(8) NOT NULL,                 -- counter | window | none
    min_interval_secs INT NOT NULL DEFAULT 0,
    models NVARCHAR(400) NULL                        -- comma list of model names mapping to this type
);
CREATE UNIQUE INDEX ux_DTM_device_types_slug ON DTM_device_types (slug);

CREATE TABLE DTM_devices
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    location_id INT NOT NULL,
    device_type_id INT NOT NULL,
    kind NVARCHAR(8) NOT NULL,                       -- denormalized from the type for list splits
    name NVARCHAR(120) NOT NULL,
    mac CHAR(12) NULL,                               -- uppercase, no separators; NULL for assets
    model NVARCHAR(40) NULL,
    firmware NVARCHAR(24) NULL,
    is_offline BIT NOT NULL DEFAULT 0,
    is_archived BIT NOT NULL DEFAULT 0,
    last_seen_epoch BIGINT NULL,
    joined_epoch BIGINT NULL,
    last_heard_by INT NULL,                          -- self reference; a direct device points at itself
    legacy_slug NVARCHAR(40) NULL,
    notes NVARCHAR(MAX) NULL,
    created_epoch BIGINT NOT NULL,
    created_by INT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_devices_locations FOREIGN KEY (location_id) REFERENCES DTM_locations (id),
    CONSTRAINT fk_DTM_devices_device_types FOREIGN KEY (device_type_id) REFERENCES DTM_device_types (id),
    CONSTRAINT fk_DTM_devices_heard_by FOREIGN KEY (last_heard_by) REFERENCES DTM_devices (id)
);
CREATE UNIQUE INDEX ux_DTM_devices_uid ON DTM_devices (uid);
-- A MAC is unique among live, unarchived devices; archived rows keep theirs for history (architecture 3.7a).
CREATE UNIQUE INDEX ux_DTM_devices_mac ON DTM_devices (mac) WHERE delete_epoch IS NULL AND is_archived = 0 AND mac IS NOT NULL;
CREATE INDEX ix_DTM_devices_location_live ON DTM_devices (location_id, kind) WHERE delete_epoch IS NULL;
CREATE INDEX ix_DTM_devices_legacy_slug ON DTM_devices (legacy_slug) WHERE legacy_slug IS NOT NULL;

-- 1:1 extension for anything that authenticates to the broker (gateways, direct devices).
CREATE TABLE DTM_device_credentials
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    device_id INT NOT NULL,
    mac CHAR(12) NOT NULL,
    state NVARCHAR(8) NOT NULL DEFAULT 'pending',    -- pending | active
    broker_username NVARCHAR(80) NOT NULL,           -- the device uid as text
    broker_password_enc NVARCHAR(400) NULL,          -- NULL under the static broker driver
    created_epoch BIGINT NOT NULL,
    rotated_epoch BIGINT NULL,
    activated_epoch BIGINT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_device_credentials_devices FOREIGN KEY (device_id) REFERENCES DTM_devices (id)
);
CREATE UNIQUE INDEX ux_DTM_device_credentials_device ON DTM_device_credentials (device_id);
CREATE UNIQUE INDEX ux_DTM_device_credentials_mac ON DTM_device_credentials (mac) WHERE delete_epoch IS NULL;

-- Permanent birth record. Never deleted; the app login gets no DELETE here (architecture 3.8).
CREATE TABLE DTM_device_registry
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    mac CHAR(12) NOT NULL,
    first_model NVARCHAR(40) NULL,
    first_firmware NVARCHAR(24) NULL,
    first_heard_epoch BIGINT NOT NULL,
    first_heard_via NVARCHAR(16) NOT NULL,           -- provision | join | frame | ble | manual
    last_firmware NVARCHAR(24) NULL,
    last_heard_epoch BIGINT NOT NULL,
    last_device_uid UNIQUEIDENTIFIER NULL
);
CREATE UNIQUE INDEX ux_DTM_device_registry_mac ON DTM_device_registry (mac);

-- Which gateways hear which device; upserted on every frame including dedup losers.
CREATE TABLE DTM_device_coverage
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    device_id INT NOT NULL,
    gateway_id INT NOT NULL,
    last_heard_epoch BIGINT NOT NULL,
    last_rssi SMALLINT NULL,
    CONSTRAINT fk_DTM_device_coverage_devices FOREIGN KEY (device_id) REFERENCES DTM_devices (id),
    CONSTRAINT fk_DTM_device_coverage_gateways FOREIGN KEY (gateway_id) REFERENCES DTM_devices (id)
);
CREATE UNIQUE INDEX ux_DTM_device_coverage_pair ON DTM_device_coverage (device_id, gateway_id);
CREATE INDEX ix_DTM_device_coverage_gateway ON DTM_device_coverage (gateway_id, last_heard_epoch);
