-- Ignored unclaimed devices (DECISIONS "Unclaimed devices, per account"). One row per ignore:
-- account_id set hides the MAC for that account only (its Unclaimed devices page, and auto claim
-- skips it); account_id NULL is a superadmin ignore that hides it from the unknown devices page
-- only, never from an account. Unignore deletes the row (audited). The unique index treats NULL as
-- a value, so each MAC has at most one superadmin ignore and one per account.
CREATE TABLE DTM_unclaimed_ignored
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    account_id INT NULL,
    mac CHAR(12) NOT NULL,
    ignored_by INT NULL,
    ignored_epoch BIGINT NOT NULL,
    CONSTRAINT fk_DTM_unclaimed_ignored_accounts FOREIGN KEY (account_id) REFERENCES DTM_accounts (id)
);
CREATE UNIQUE INDEX ux_DTM_unclaimed_ignored_scope ON DTM_unclaimed_ignored (account_id, mac);
CREATE INDEX ix_DTM_unclaimed_ignored_mac ON DTM_unclaimed_ignored (mac);
