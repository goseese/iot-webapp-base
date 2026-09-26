// Leader election across instances (IIS farm members, overlapping recycles). One instance holds a
// SQL Server application lock and runs ingest and jobs; the others serve web only and retry.
// The lock lives on a dedicated connection outside the knex pool: SQL Server releases a session
// lock when its connection closes, so a dead leader frees it and another instance takes over.
const { Connection, Request } = require("tedious");
const env = require("../config/env");
const logger = require("../config/logger");

const RESOURCE = "devmon-leader";
const INTERVAL_MS = 15000;

let conn = null;
let leader = false;
let busy = false;
let onLeader = null;

function openConnection()
{
    return new Promise((resolve, reject) =>
    {
        const c = new Connection(
        {
            server: env.db.host,
            authentication: { type: "default", options: { userName: env.db.user, password: env.db.password } },
            options:
            {
                port: env.db.port,
                database: env.db.name,
                encrypt: env.db.encrypt,
                trustServerCertificate: env.db.trustCert,
                appName: "devmon-leader"
            }
        });
        c.on("end", () => lost(c, "connection closed"));
        c.on("error", (err) => lost(c, err.message));
        c.connect((err) =>
        {
            if (err)
            {
                reject(err);
                return;
            }
            resolve(c);
        });
    });
}

// Runs one batch on the lock connection and returns the first column of the last row.
function scalar(sql)
{
    return new Promise((resolve, reject) =>
    {
        let value = null;
        const req = new Request(sql, (err) =>
        {
            if (err)
            {
                reject(err);
                return;
            }
            resolve(value);
        });
        req.on("row", (columns) =>
        {
            value = columns[0].value;
        });
        conn.execSqlBatch(req);
    });
}

// A leader that loses its lock connection must stop at once; exiting is the only way to be sure
// ingest and every job stop together. iisnode starts the process again on the next request.
function lost(c, reason)
{
    if (c !== conn)
    {
        return;
    }
    conn = null;
    if (leader)
    {
        logger.fatal({ reason: reason }, "leader lock lost, exiting");
        process.exit(1);
    }
    logger.warn({ reason: reason }, "leader lock connection lost, will retry");
}

async function tick()
{
    if (busy)
    {
        return;
    }
    busy = true;
    try
    {
        if (!conn)
        {
            conn = await openConnection();
        }
        if (leader)
        {
            const mode = await scalar("SELECT APPLOCK_MODE('public', N'" + RESOURCE + "', 'Session')");
            if (mode !== "Exclusive")
            {
                logger.fatal({ mode: mode }, "leader lock no longer held, exiting");
                process.exit(1);
            }
            return;
        }
        const r = await scalar(
            "DECLARE @r int; " +
            "EXEC @r = sp_getapplock @Resource = N'" + RESOURCE + "', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0; " +
            "SELECT @r;");
        if (r >= 0)
        {
            leader = true;
            logger.info({ resource: RESOURCE }, "leader lock acquired, starting ingest and jobs");
            onLeader();
        }
    }
    catch (err)
    {
        if (leader)
        {
            logger.fatal({ err: err.message }, "leader check failed, exiting");
            process.exit(1);
        }
        logger.warn({ err: err.message }, "leader lock attempt failed, will retry");
        if (conn)
        {
            const c = conn;
            conn = null;
            try
            {
                c.close();
            }
            catch (e)
            {
                // already closed
            }
        }
    }
    finally
    {
        busy = false;
    }
}

function start(callback)
{
    onLeader = callback;
    tick();
    setInterval(tick, INTERVAL_MS);
}

function isLeader()
{
    return leader;
}

module.exports = { start, isLeader };
