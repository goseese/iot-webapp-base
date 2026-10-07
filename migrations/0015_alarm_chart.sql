-- Chart image in alarm emails (DECISIONS.md "Chart image in alarm emails"). Threshold rules only;
-- no_data rules never send one. chart_window_secs NULL is Auto: twice exceed_secs, at least 30 days,
-- at most a year (services/alarms/chartImage.js windowFor()).
ALTER TABLE alarm_rules ADD COLUMN chart_in_alarm BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE alarm_rules ADD COLUMN chart_window_secs INTEGER NULL;
