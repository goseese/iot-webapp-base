-- Site settings get a group for the admin tabs: general | email | sms | logging | api.
ALTER TABLE DTM_settings ADD setting_group NVARCHAR(20) NOT NULL CONSTRAINT df_DTM_settings_group DEFAULT 'general';
