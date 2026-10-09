-- Retained status cleanup, step 3 (DECISIONS.md "Retained status cleanup"). mqtt_last_epoch: the
-- last MQTT message from the unit, written by ingest at most once an hour per unit (mqtt_seen_epoch
-- stays the first one). status_cleared_epoch: when the server cleared the unit's retained status
-- (Reprovision, or the daily job for a unit silent for RETAINED_STATUS_DAYS); NULL again as soon as
-- the unit is heard, because it republishes its retained connect message.
ALTER TABLE device_credentials ADD COLUMN mqtt_last_epoch BIGINT NULL;
ALTER TABLE device_credentials ADD COLUMN status_cleared_epoch BIGINT NULL;
