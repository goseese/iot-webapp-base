-- Run once as an administrator against the devmon server. Creates the app login the .env on the
-- IIS box uses. Migrations need DDL rights; audit_log and device_registry are append only for the
-- app (architecture 3.8, 13). Replace the password before running.
USE master;
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'devmon_app')
    CREATE LOGIN devmon_app WITH PASSWORD = 'CHANGE-ME-Strong-Password-1!', CHECK_POLICY = ON;
IF DB_ID('devmon') IS NULL
    CREATE DATABASE devmon;
GO
USE devmon;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'devmon_app')
    CREATE USER devmon_app FOR LOGIN devmon_app;
ALTER ROLE db_ddladmin ADD MEMBER devmon_app;
ALTER ROLE db_datareader ADD MEMBER devmon_app;
ALTER ROLE db_datawriter ADD MEMBER devmon_app;
GO
-- Once the first deploy has created the tables, run this second half to remove DELETE on the
-- permanent tables. (DENY on a table that does not exist yet fails, hence the two passes.)
IF OBJECT_ID('DTM_audit_log') IS NOT NULL DENY DELETE, UPDATE ON DTM_audit_log TO devmon_app;
IF OBJECT_ID('DTM_device_registry') IS NOT NULL DENY DELETE ON DTM_device_registry TO devmon_app;
GO
