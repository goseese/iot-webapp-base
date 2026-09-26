// Runs a piece of work on one instance at a time across the farm, using a SQL Server application
// lock held on a dedicated connection outside the knex pool. Used at boot so migrations and seeds
// never run on two servers at once; the other instances wait, then find nothing pending.
const { Connection, Request } = require("tedious");
const env = require("../config/env");

function open(requestTimeoutMs)
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
                appName: "devmon-applock",
                // tedious cancels any request after 15 s by default; the lock wait must outlast that.
                requestTimeout: requestTimeoutMs
            }
        });
        // Without a listener an 'error' event would crash the process; the pending request
        // still fails with its own error, which the caller sees.
        c.on("error", () => {});
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

// Runs one batch and returns the first column of the last row.
function scalar(c, sql)
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
        c.execSqlBatch(req);
    });
}

// sp_getapplock: 0 granted, 1 granted after waiting, -1 timed out, -2 cancelled, -3 deadlock victim.
async function withLock(resource, waitMs, work)
{
    const name = String(resource).replace(/'/g, "''");
    const c = await open(Number(waitMs) + 30000);
    try
    {
        const r = await scalar(c,
            "DECLARE @r int; " +
            "EXEC @r = sp_getapplock @Resource = N'" + name + "', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = " + Number(waitMs) + "; " +
            "SELECT @r;");
        if (r < 0)
        {
            throw new Error("could not get lock " + resource + " (sp_getapplock returned " + r + ")");
        }
        try
        {
            return await work();
        }
        finally
        {
            try
            {
                await scalar(c, "EXEC sp_releaseapplock @Resource = N'" + name + "', @LockOwner = 'Session';");
            }
            catch (e)
            {
                // closing the connection below releases it anyway
            }
        }
    }
    finally
    {
        c.close();
    }
}

module.exports = { withLock };
