-- Default CI collation makes plain unique indexes on username/email case insensitive.
CREATE TABLE DTM_users
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    username NVARCHAR(40) NOT NULL,
    email NVARCHAR(254) NOT NULL,
    display_name NVARCHAR(80) NULL,
    phone NVARCHAR(30) NULL,
    password_hash NVARCHAR(100) NULL,
    is_superadmin BIT NOT NULL DEFAULT 0,
    must_set_password BIT NOT NULL DEFAULT 0,        -- seeded/reset accounts are confined until they set one
    username_changed_epoch BIGINT NULL,
    password_changed_epoch BIGINT NULL,              -- sessions older than this are invalid
    email_enabled BIT NOT NULL DEFAULT 1,
    sms_enabled BIT NOT NULL DEFAULT 0,
    email_paused_until_epoch BIGINT NULL,
    sms_paused_until_epoch BIGINT NULL,
    email_bounced BIT NOT NULL DEFAULT 0,
    last_login_epoch BIGINT NULL,
    created_epoch BIGINT NOT NULL,
    created_by INT NULL,
    delete_epoch BIGINT NULL
);
CREATE UNIQUE INDEX ux_DTM_users_uid ON DTM_users (uid);
CREATE UNIQUE INDEX ux_DTM_users_username ON DTM_users (username) WHERE delete_epoch IS NULL;
CREATE UNIQUE INDEX ux_DTM_users_email ON DTM_users (email) WHERE delete_epoch IS NULL;

CREATE TABLE DTM_username_history
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    user_id INT NOT NULL,
    old_username NVARCHAR(40) NOT NULL,
    changed_epoch BIGINT NOT NULL,
    CONSTRAINT fk_DTM_username_history_users FOREIGN KEY (user_id) REFERENCES DTM_users (id)
);

-- One grants table for users and API credentials (architecture 4.3). Bits from permissions.js.
CREATE TABLE DTM_grants
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    grantee_type NVARCHAR(14) NOT NULL,              -- user | api_credential
    grantee_id INT NOT NULL,
    scope_type NVARCHAR(8) NOT NULL,                 -- account | location
    scope_id INT NOT NULL,
    permission_bits BIGINT NOT NULL,
    created_epoch BIGINT NOT NULL,
    created_by INT NULL
);
CREATE UNIQUE INDEX ux_DTM_grants_scope ON DTM_grants (grantee_type, grantee_id, scope_type, scope_id);
CREATE INDEX ix_DTM_grants_scope ON DTM_grants (scope_type, scope_id);

CREATE TABLE DTM_invites
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    email NVARCHAR(254) NOT NULL,
    username NVARCHAR(40) NOT NULL,
    scope_type NVARCHAR(8) NOT NULL,
    scope_id INT NOT NULL,
    permission_bits BIGINT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_epoch BIGINT NOT NULL,
    accepted_epoch BIGINT NULL,
    cancelled_epoch BIGINT NULL,
    created_epoch BIGINT NOT NULL,
    created_by INT NOT NULL
);
CREATE UNIQUE INDEX ux_DTM_invites_uid ON DTM_invites (uid);
CREATE UNIQUE INDEX ux_DTM_invites_live_email ON DTM_invites (email) WHERE accepted_epoch IS NULL AND cancelled_epoch IS NULL;
CREATE UNIQUE INDEX ux_DTM_invites_token ON DTM_invites (token_hash);

CREATE TABLE DTM_api_credentials
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NULL,                             -- NULL = superadmin global credential
    name NVARCHAR(80) NOT NULL,
    key_prefix NVARCHAR(12) NOT NULL,
    key_hash CHAR(64) NOT NULL,
    is_enabled BIT NOT NULL DEFAULT 1,
    expires_epoch BIGINT NULL,
    last_used_epoch BIGINT NULL,
    created_epoch BIGINT NOT NULL,
    created_by INT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_api_credentials_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_api_credentials_uid ON DTM_api_credentials (uid);
CREATE UNIQUE INDEX ux_DTM_api_credentials_hash ON DTM_api_credentials (key_hash);

-- Shared magic link mechanics (architecture 4.2): reset links, alarm action links, test sends.
CREATE TABLE DTM_tokens
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    purpose NVARCHAR(24) NOT NULL,                   -- password_reset | alarm_action | ...
    subject_type NVARCHAR(16) NOT NULL,
    subject_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    meta NVARCHAR(MAX) NULL,
    expires_epoch BIGINT NOT NULL,
    used_epoch BIGINT NULL,
    created_epoch BIGINT NOT NULL
);
CREATE UNIQUE INDEX ux_DTM_tokens_hash ON DTM_tokens (token_hash);
CREATE INDEX ix_DTM_tokens_subject ON DTM_tokens (purpose, subject_type, subject_id);
