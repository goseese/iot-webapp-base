-- Battery chemistry override for one device (placement). NULL means the device type's
-- batteryChemistry default. Keys are those in services/levels.js BATTERY (cr2477, li_ion, ...);
-- the settings route only accepts those. Used for int-vbat-pct.
ALTER TABLE DTM_devices ADD battery_chemistry NVARCHAR(24) NULL;
