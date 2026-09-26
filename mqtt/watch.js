// Applies MQTT setting changes without a restart, on every farm process. Polls the newest
// updated_epoch of the mqtt settings rows (settings.set stamps it); when it moves, settings
// reload and the ingest client (leader only) and the realtime relay reconnect.
const { knex, T } = require("../db/knex");
const settings = require("../config/settings");
const logger = require("../config/logger");

const POLL_MS = 15000;
let last = null;
let timer = null;

async function stamp()
{
    const row = await knex(T("settings")).where({ setting_group: "mqtt" }).max("updated_epoch as latest").first();
    return row && row.latest !== null && row.latest !== undefined ? Number(row.latest) : 0;
}

async function check()
{
    try
    {
        const latest = await stamp();
        if (latest === last) { return; }
        last = latest;
        await settings.reload();
        logger.info({ updated_epoch: latest }, "mqtt settings changed; reconnecting");
        require("./client").reconnect();
        require("../realtime").reconnect();
        // The dynsec admin connection uses the same host and credentials, so it has to follow too.
        // A driver that manages nothing has no reconnect, and dynsec's is a no op unless connected.
        const driver = require("../services/broker").active();
        if (typeof driver.reconnect === "function") { driver.reconnect(); }
    }
    catch (err) { logger.warn({ err: err.message }, "mqtt settings check failed"); }
}

async function start()
{
    if (timer) { return; }
    last = await stamp();
    timer = setInterval(check, POLL_MS);
    timer.unref();
}

module.exports = { start };
