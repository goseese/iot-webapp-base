// Creates the database named in .env if it does not exist, via master. Used by boot (so a
// new DB_NAME is enough for a fresh install) and by scripts/create-db.js. Needs CREATE DATABASE
// on the login; when that is missing it reports and lets the normal connect show the error.
const knexLib = require("knex");
const env = require("../config/env");

async function ensureDatabase(log)
{
    const master = knexLib(
    {
        client: "mssql",
        connection:
        {
            host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, database: "master",
            options: { encrypt: env.db.encrypt, trustServerCertificate: env.db.trustCert, connectTimeout: 15000 }
        },
        pool: { min: 0, max: 1 }
    });
    try
    {
        const exists = await master.raw("SELECT DB_ID(?) AS id", [env.db.name]);
        const row = Array.isArray(exists) ? exists[0] : exists;
        if (row && row.id !== null && row.id !== undefined)
        {
            return { created: false, existed: true };
        }
        await master.raw("EXEC('CREATE DATABASE [' + REPLACE(?, ']', ']]') + ']')", [env.db.name]);
        if (log) { log.info({ db: env.db.name }, "database created"); }
        return { created: true, existed: false };
    }
    catch (err)
    {
        if (log) { log.warn({ db: env.db.name, err: err.message }, "could not check or create the database via master; continuing"); }
        return { created: false, existed: null, error: err.message };
    }
    finally
    {
        await master.destroy();
    }
}

module.exports = { ensureDatabase };
