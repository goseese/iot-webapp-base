-- Hidden sensors (DECISIONS "Sensor delete and hide"). A hidden sensor still stores readings but
-- evaluates no alarms and is left out of the device's sensor list (unless Show hidden) and out of
-- chart pickers. Not the same as is_enabled = 0, which stops storing readings.
ALTER TABLE DTM_sensors ADD is_hidden BIT NOT NULL DEFAULT 0;
