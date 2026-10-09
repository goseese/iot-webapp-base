// The only place the database driver is configured. All SQL lives under db/.
const fs = require("fs");
const knexLib = require("knex");
const env = require("../config/env");

// No table prefix. T() stays as a pass through so existing call sites need no change.
const PREFIX = "";

// RDS forces SSL. The server certificate is verified against the RDS CA bundle named by
// DB_SSL_CA. Local dev containers set DB_SSL=false.
function sslOptions()
{
    if (!env.db.ssl)
    {
        return false;
    }
    if (!env.db.sslCa)
    {
        throw new Error("env DB_SSL_CA is required when DB_SSL is on (path to the RDS CA bundle, see .env.example)");
    }
    return { ca: fs.readFileSync(env.db.sslCa, "utf8"), rejectUnauthorized: true };
}

// node-postgres client settings. Exported so createDb uses the same host, credentials and SSL.
// knex deep clones this, so sharing is safe.
const connection =
{
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.name,
    ssl: sslOptions(),
    application_name: env.slug
};

const knex = knexLib(
{
    client: "pg",
    connection: connection,
    pool: { min: 0, max: 10 }
});

// T("devices") -> "devices". Kept so a prefix could return in one place if ever needed.
function T(name)
{
    return PREFIX + name;
}

// Epoch seconds, app side. Passed into statements so app and DB never disagree
// inside one transaction (schema-conventions.md section 3).
function nowEpoch()
{
    return Math.floor(Date.now() / 1000);
}

// knex pg returns [{ id }] from .returning("id"); some dialects return [id]. One place decides.
function insertId(rows, column)
{
    const col = column || "id";
    const first = Array.isArray(rows) ? rows[0] : rows;
    return first && typeof first === "object" && first[col] !== undefined ? first[col] : first;
}

// Postgres unique_violation (SQLSTATE 23505): a unique index rejected the write. Callers use it
// where the index is the arbiter (dedup claims, first contact, lost races).
function isUniqueViolation(err)
{
    return !!err && err.code === "23505";
}

module.exports = { knex, connection, T, PREFIX, nowEpoch, insertId, isUniqueViolation };
