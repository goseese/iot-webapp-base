// Forward only SQL migrations. Files in migrations/ named NNNN_name.sql, applied in name order;
// applied ids recorded in schema_migrations. Each file runs in its own transaction as one multi
// statement query (no bindings, so node-postgres uses the simple protocol and needs no batching).
// knex still rewrites every ? into a $n placeholder, so a literal ? anywhere in a migration file
// (comment, string, jsonb operator) must be written \? .
const fs = require("fs");
const path = require("path");
const { knex, T } = require("./knex");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const TABLE = T("schema_migrations");

// Transaction level advisory lock, so a manual "npm run migrate" during a boot never applies a
// file twice. Any fixed bigint works; this one is "Volt" in ASCII.
const LOCK_KEY = 1450142836;

// Under the same lock: CREATE TABLE IF NOT EXISTS is not safe against a concurrent create.
async function ensureTable()
{
    await knex.transaction(async (trx) =>
    {
        await trx.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
        await trx.raw(
            "CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
            " id VARCHAR(120) NOT NULL PRIMARY KEY," +
            " applied_epoch BIGINT NOT NULL)");
    });
}

function listFiles()
{
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
}

async function pending()
{
    await ensureTable();
    const applied = new Set((await knex(TABLE).select("id")).map((r) => r.id));
    return listFiles().filter((f) => !applied.has(f));
}

async function run(log)
{
    const files = await pending();
    const done = [];
    for (const file of files)
    {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
        const applied = await knex.transaction(async (trx) =>
        {
            await trx.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
            // Another process may have applied it while this one waited for the lock.
            if (await trx(TABLE).where({ id: file }).first())
            {
                return false;
            }
            await trx.raw(sql);
            await trx(TABLE).insert({ id: file, applied_epoch: Math.floor(Date.now() / 1000) });
            return true;
        });
        if (applied)
        {
            done.push(file);
            if (log) { log.info({ migration: file }, "applied"); }
        }
    }
    return done;
}

module.exports = { run, pending };
