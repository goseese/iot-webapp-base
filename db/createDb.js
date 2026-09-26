// Creates the database named in .env if it does not exist, via the "postgres" maintenance
// database. Used by boot (so a new DB_NAME is enough for a fresh install) and by
// scripts/create-db.js. Needs CREATEDB on the login (the RDS master user has it); when that is
// missing it reports and lets the normal connect show the error.
const knexLib = require("knex");
const env = require("../config/env");
const { connection } = require("./knex");

async function ensureDatabase(log)
{
    const admin = knexLib(
    {
        client: "pg",
        connection: Object.assign({}, connection, { database: "postgres", connectionTimeoutMillis: 15000 }),
        pool: { min: 0, max: 1 }
    });
    try
    {
        const exists = await admin.raw("SELECT 1 FROM pg_database WHERE datname = ?", [env.db.name]);
        if (exists.rows.length > 0)
        {
            return { created: false, existed: true };
        }
        // CREATE DATABASE takes no bind parameters and cannot run inside a transaction.
        await admin.raw("CREATE DATABASE \"" + env.db.name.replace(/"/g, "\"\"") + "\"");
        if (log) { log.info({ db: env.db.name }, "database created"); }
        return { created: true, existed: false };
    }
    catch (err)
    {
        if (log) { log.warn({ db: env.db.name, err: err.message }, "could not check or create the database via postgres; continuing"); }
        return { created: false, existed: null, error: err.message };
    }
    finally
    {
        await admin.destroy();
    }
}

module.exports = { ensureDatabase };
