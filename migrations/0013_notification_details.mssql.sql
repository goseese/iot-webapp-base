-- Full message and the provider's raw answer, for the notification detail view.
ALTER TABLE DTM_notifications ADD body NVARCHAR(MAX) NULL, provider_response NVARCHAR(MAX) NULL, sender NVARCHAR(254) NULL;
