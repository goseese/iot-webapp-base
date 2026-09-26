-- Optional long description per sensor. NULL = inherit the device type channel's description.
ALTER TABLE DTM_sensors ADD description NVARCHAR(MAX) NULL;
