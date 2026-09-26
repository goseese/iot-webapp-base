// The only place the database driver is configured. All SQL lives under db/.
const knexLib = require("knex");
const env = require("../config/env");

const PREFIX = "DTM_";

const knex = knexLib(
{
    client: "mssql",
    connection:
    {
        host: env.db.host,
        port: env.db.port,
        user: env.db.user,
        password: env.db.password,
        database: env.db.name,
        options:
        {
            encrypt: env.db.encrypt,
            trustServerCertificate: env.db.trustCert,
            useUTC: true,
            appName: "devmon"
        }
    },
    pool: { min: 0, max: 10 }
});

// T("devices") -> "DTM_devices". Every table reference goes through here so the
// customer's prefix convention is enforced in exactly one place.
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

// knex mssql returns [{ id }] from .returning("id"); other dialects return [id]. One place decides.
function insertId(rows, column)
{
    const col = column || "id";
    const first = Array.isArray(rows) ? rows[0] : rows;
    return first && typeof first === "object" && first[col] !== undefined ? first[col] : first;
}

module.exports = { knex, T, PREFIX, nowEpoch, insertId };
