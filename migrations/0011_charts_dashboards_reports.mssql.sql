-- A chart is one JSON object; a dashboard is a collection of charts and/or tag queries (architecture 9).
CREATE TABLE DTM_charts
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NOT NULL,
    owner_user_id INT NOT NULL,
    name NVARCHAR(120) NOT NULL,
    visibility NVARCHAR(12) NOT NULL DEFAULT 'private', -- private | account_view | account_edit
    definition_json NVARCHAR(MAX) NOT NULL,
    created_epoch BIGINT NOT NULL,
    updated_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_charts_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_charts_uid ON DTM_charts (uid);

CREATE TABLE DTM_dashboards
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NOT NULL,
    owner_user_id INT NOT NULL,
    name NVARCHAR(120) NOT NULL,
    visibility NVARCHAR(12) NOT NULL DEFAULT 'private',
    tabs NVARCHAR(MAX) NOT NULL,                     -- [{name, chart_uid | tag_query}]
    created_epoch BIGINT NOT NULL,
    updated_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_dashboards_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_dashboards_uid ON DTM_dashboards (uid);

CREATE TABLE DTM_reports
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    uid UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    account_id INT NOT NULL,
    location_id INT NULL,
    owner_user_id INT NOT NULL,
    name NVARCHAR(120) NOT NULL,
    report_type NVARCHAR(40) NOT NULL,               -- reportTypes/<slug>.js
    query_json NVARCHAR(MAX) NOT NULL,
    options_json NVARCHAR(MAX) NULL,
    schedule_json NVARCHAR(400) NULL,                     -- {mode, time, days}; NULL = manual only
    output_kind NVARCHAR(12) NOT NULL DEFAULT 'html',     -- html | csv | xlsx
    visibility NVARCHAR(12) NOT NULL DEFAULT 'private',
    is_enabled BIT NOT NULL DEFAULT 1,
    last_run_epoch BIGINT NULL,
    created_epoch BIGINT NOT NULL,
    delete_epoch BIGINT NULL,
    CONSTRAINT fk_DTM_reports_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_reports_uid ON DTM_reports (uid);

CREATE TABLE DTM_report_recipients
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    report_id INT NOT NULL,
    recipient_type NVARCHAR(8) NOT NULL,             -- user | contact
    recipient_id INT NOT NULL,
    CONSTRAINT fk_DTM_report_recipients_reports FOREIGN KEY (report_id) REFERENCES DTM_reports (id)
);
CREATE UNIQUE INDEX ux_DTM_report_recipients ON DTM_report_recipients (report_id, recipient_type, recipient_id);

CREATE TABLE DTM_report_runs
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    report_id INT NOT NULL,
    epoch BIGINT NOT NULL,
    trigger_kind NVARCHAR(8) NOT NULL,               -- schedule | manual
    outcome NVARCHAR(10) NOT NULL,                   -- ok | failed
    row_count INT NULL,
    file_path NVARCHAR(300) NULL,
    error NVARCHAR(500) NULL,
    CONSTRAINT fk_DTM_report_runs_reports FOREIGN KEY (report_id) REFERENCES DTM_reports (id)
);
CREATE INDEX ix_DTM_report_runs_report ON DTM_report_runs (report_id, epoch);
