-- Sessions live in the database so IIS and multi process web work identically.
-- Column names are what connect-session-knex expects (sid, sess, expired).
CREATE TABLE DTM_sessions
(
    sid NVARCHAR(255) NOT NULL PRIMARY KEY,
    sess NVARCHAR(MAX) NOT NULL,
    expired DATETIME2 NOT NULL
);
CREATE INDEX ix_DTM_sessions_expired ON DTM_sessions (expired);
