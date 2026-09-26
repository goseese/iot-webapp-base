-- key_prefix holds the visible key start, <API_KEY_PREFIX>_<8 hex>: up to 16 + 1 + 8 = 25 characters.
ALTER TABLE DTM_api_credentials ALTER COLUMN key_prefix NVARCHAR(26) NOT NULL;
