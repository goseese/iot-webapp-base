// Feeds the platform_server device through the normal pipeline every minute, so server health
// gets charts and alarm limits like any other sensor.
const env = require("../../config/env");
const { knex, T, nowEpoch } = require("../../db/knex");
const deviceTypes = require("../../deviceTypes");
const devicesRepo = require("../../db/repos/devices");
const pipeline = require("../../pipeline");
const mqttClient = require("../../mqtt/client");

// Measured through the public URL so it includes IIS; under iisnode there is no local TCP port.
async function httpResponseMs()
{
    const started = process.hrtime.bigint();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try
    {
        const res = await fetch(env.appUrl.replace(/\/$/, "") + "/health", { signal: ctl.signal });
        await res.text();
        return Number(process.hrtime.bigint() - started) / 1e6;
    }
    catch (err) { return 5000; }
    finally { clearTimeout(timer); }
}

async function dbQueryMs()
{
    const started = process.hrtime.bigint();
    await knex(T("settings")).count("id as n").first();
    return Number(process.hrtime.bigint() - started) / 1e6;
}

function eventLoopLagMs()
{
    return new Promise((resolve) =>
    {
        const started = process.hrtime.bigint();
        setImmediate(() => resolve(Number(process.hrtime.bigint() - started) / 1e6));
    });
}

async function run()
{
    const device = await devicesRepo.findLiveByHardwareId(new URL(env.appUrl).hostname);
    if (!device) { return; }   // seeded at boot; nothing to feed until then

    const activeAlarms = await knex(T("alarms")).whereNull("cleared_epoch").count("id as n").first();
    const values =
    {
        http_response_ms: await httpResponseMs(),
        db_query_ms: await dbQueryMs(),
        event_loop_lag_ms: await eventLoopLagMs(),
        heap_used: process.memoryUsage().heapUsed,
        mqtt_connected: mqttClient.isConnected() ? 1 : 0,
        ingest_lag_secs: mqttClient.lastLatency() / 1000,
        active_alarms: Number(activeAlarms.n)
    };
    await pipeline.ingest({ device: device, type: deviceTypes.get("platform_server"), epoch: nowEpoch(), values: values, gatewayId: device.id });
}

module.exports = { run };
