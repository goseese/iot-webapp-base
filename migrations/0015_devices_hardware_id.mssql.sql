-- devices.mac becomes hardware_id: a string identifying the hardware (MAC, host name, IMEI),
-- not an FK. Global uniqueness among live, unarchived devices stays (architecture 3.7a).
-- device_credentials.mac and device_registry.mac are untouched.
DROP INDEX ux_DTM_devices_mac ON DTM_devices;
GO
ALTER TABLE DTM_devices ALTER COLUMN mac NVARCHAR(255) NULL;
GO
EXEC sp_rename 'DTM_devices.mac', 'hardware_id', 'COLUMN';
GO
EXEC('UPDATE DTM_devices SET hardware_id = RTRIM(hardware_id) WHERE hardware_id IS NOT NULL');
GO
EXEC('CREATE UNIQUE INDEX ux_DTM_devices_hardware_id ON DTM_devices (hardware_id) WHERE delete_epoch IS NULL AND is_archived = 0 AND hardware_id IS NOT NULL');
GO
