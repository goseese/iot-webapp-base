-- device_credentials becomes the MQTT identity of the physical UNIT, keyed by MAC, instead of a 1:1
-- extension of a device row. Reverses the identity model's "the MQTT username is the device table
-- GUID" (see DECISIONS.md).
--
--   Unit       keyed by MAC, lives forever. Owns the broker username (a GUID), the password and
--              the topics dev/{guid}/... A unit can hold credentials with no placement at all:
--              that is an unclaimed unit, fresh from the shop.
--   Placement  a DTM_devices row: one stint at one location, owning sensors, history and alarms.
--              Its uid is no longer the MQTT username.
--
-- A unit's current placement is not stored. It is the one live, unarchived device row whose
-- hardware_id is the unit's MAC, which ux_DTM_devices_hardware_id already allows exactly one of.
-- Removing a device from a location archives its row, so the unit keeps its credentials and stays
-- connected with nowhere for its data to go; adding the MAC somewhere makes a new current placement.

-- device_id no longer means anything for new rows and nothing writes it. Kept, nullable, for rows
-- written under the old model. The unique index goes: a plain unique index in SQL Server admits only
-- one NULL, and a unit with no placement has no device.
DROP INDEX ux_DTM_device_credentials_device ON DTM_device_credentials;
GO
ALTER TABLE DTM_device_credentials ALTER COLUMN device_id INT NULL;
GO

-- type_slug: the device type the unit declared in its provisioning request, validated against the
--            deviceTypes modules. Pre fills the type when the unit is claimed into a location.
-- mqtt_seen_epoch: first message received from the unit over MQTT. The 30 day cleanup revokes
--            units that were issued credentials and never connected.
ALTER TABLE DTM_device_credentials ADD type_slug NVARCHAR(40) NULL, mqtt_seen_epoch BIGINT NULL;
GO

-- The unit GUID is how ingest finds a unit from a topic, once per inbound message. Unique among
-- live rows, which also guarantees no two units can ever share a username.
CREATE UNIQUE INDEX ux_DTM_device_credentials_broker_username
    ON DTM_device_credentials (broker_username)
    WHERE delete_epoch IS NULL;
GO

-- Existing rows: take the type from their current device row.
EXEC('UPDATE c SET c.type_slug = t.slug
      FROM DTM_device_credentials c
      JOIN DTM_devices d ON d.id = c.device_id
      JOIN DTM_device_types t ON t.id = d.device_type_id
      WHERE c.type_slug IS NULL');
GO

-- Existing ACTIVE rows belong to gateways that provisioned and connected under the old model. Left
-- NULL, the cleanup would revoke live gateways 30 days after this ships, so stamp them as seen.
-- Pending rows are untouched: they were never issued anything, and the cleanup ignores them.
EXEC('UPDATE DTM_device_credentials
      SET mqtt_seen_epoch = COALESCE(activated_epoch, created_epoch)
      WHERE state = ''active'' AND mqtt_seen_epoch IS NULL');
GO
