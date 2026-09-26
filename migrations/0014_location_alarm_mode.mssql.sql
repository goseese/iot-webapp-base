-- Location alarm mode: active | muted (evaluate, do not notify) | offline (do not evaluate at all).
-- notifications_muted stays as the notification gate and is kept in sync (muted and offline both set it).
ALTER TABLE DTM_locations ADD alarm_mode NVARCHAR(8) NOT NULL CONSTRAINT df_DTM_locations_alarm_mode DEFAULT 'active';
GO
UPDATE DTM_locations SET alarm_mode = 'muted' WHERE notifications_muted = 1;
