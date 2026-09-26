CREATE TABLE DTM_account_settings
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    account_id INT NOT NULL,
    setting_key NVARCHAR(80) NOT NULL,
    setting_value NVARCHAR(MAX) NULL,
    updated_epoch BIGINT NOT NULL,
    updated_by INT NULL,
    CONSTRAINT fk_DTM_account_settings_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_account_settings_key ON DTM_account_settings (account_id, setting_key);

CREATE TABLE DTM_location_settings
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    location_id INT NOT NULL,
    setting_key NVARCHAR(80) NOT NULL,
    setting_value NVARCHAR(MAX) NULL,
    updated_epoch BIGINT NOT NULL,
    updated_by INT NULL,
    CONSTRAINT fk_DTM_location_settings_locations FOREIGN KEY (location_id) REFERENCES DTM_locations (id)
);
CREATE UNIQUE INDEX ux_DTM_location_settings_key ON DTM_location_settings (location_id, setting_key);

-- Lists inherit downward with merge; a child may hide an inherited item, not edit it (architecture 5.2).
CREATE TABLE DTM_lists
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    slug NVARCHAR(40) NOT NULL,
    scope_type NVARCHAR(8) NOT NULL,                 -- site | account | location
    scope_id INT NULL,
    display_name NVARCHAR(80) NOT NULL,
    order_mode NVARCHAR(12) NOT NULL DEFAULT 'entered' -- entered | alphabetical | manual
);
CREATE UNIQUE INDEX ux_DTM_lists_scope ON DTM_lists (slug, scope_type, scope_id);

CREATE TABLE DTM_list_items
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    list_id INT NOT NULL,
    label NVARCHAR(120) NOT NULL,
    value NVARCHAR(120) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    meta NVARCHAR(MAX) NULL,                         -- e.g. {"apply_tags":["dashboard"]}
    CONSTRAINT fk_DTM_list_items_lists FOREIGN KEY (list_id) REFERENCES DTM_lists (id)
);
CREATE INDEX ix_DTM_list_items_list ON DTM_list_items (list_id, sort_order);

CREATE TABLE DTM_list_item_hides
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    list_item_id INT NOT NULL,
    scope_type NVARCHAR(8) NOT NULL,
    scope_id INT NOT NULL,
    CONSTRAINT fk_DTM_list_item_hides_items FOREIGN KEY (list_item_id) REFERENCES DTM_list_items (id)
);
CREATE UNIQUE INDEX ux_DTM_list_item_hides ON DTM_list_item_hides (list_item_id, scope_type, scope_id);

CREATE TABLE DTM_tags
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    account_id INT NOT NULL,
    name NVARCHAR(40) NOT NULL,
    is_known BIT NOT NULL DEFAULT 0,                 -- seeded from code (dashboard, dailyReport)
    CONSTRAINT fk_DTM_tags_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_tags_name ON DTM_tags (account_id, name);

CREATE TABLE DTM_taggings
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    tag_id INT NOT NULL,
    entity_type NVARCHAR(10) NOT NULL,               -- device | sensor | location
    entity_id INT NOT NULL,
    CONSTRAINT fk_DTM_taggings_tags FOREIGN KEY (tag_id) REFERENCES DTM_tags (id)
);
CREATE UNIQUE INDEX ux_DTM_taggings ON DTM_taggings (tag_id, entity_type, entity_id);
CREATE INDEX ix_DTM_taggings_entity ON DTM_taggings (entity_type, entity_id);
