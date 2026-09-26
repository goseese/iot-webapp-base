// Forward only SQL migrations. Files in migrations/ named NNNN_name.mssql.sql or
// NNNN_name.sql; applied ids recorded in DTM_schema_migrations.
const fs = require("fs");
const path = require("path");
const { knex, T } = require("./knex");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const TABLE = T("schema_migrations");

async function ensureTable()
{
    const exists = await knex.schema.hasTable(TABLE);
    if (!exists)
    {
        await knex.raw(
            "CREATE TABLE " + TABLE + " (" +
            " id NVARCHAR(120) NOT NULL PRIMARY KEY," +
            " applied_epoch BIGINT NOT NULL)");
    }
}

function listFiles()
{
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql") && !f.endsWith(".pg.sql"))
        .sort();
}

// SQL Server needs some statements alone in a batch (CREATE VIEW etc), so files may
// contain GO separators like sqlcmd scripts.
function splitBatches(sql)
{
    return sql.split(/^\s*GO\s*$/mi).map((s) => s.trim()).filter((s) => s.length > 0);
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
    for (const file of files)
    {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
        const batches = splitBatches(sql);
        await knex.transaction(async (trx) =>
        {
            for (const batch of batches)
            {
                await trx.raw(batch);
            }
            await trx(TABLE).insert({ id: file, applied_epoch: Math.floor(Date.now() / 1000) });
        });
        if (log) { log.info({ migration: file }, "applied"); }
    }
    return files;
}

module.exports = { run, pending, splitBatches };
