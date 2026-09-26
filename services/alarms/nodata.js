// no_data evaluation with gateway offline suppression (architecture 8.4). Runs every minute.
// Raise for device D is suppressed when every gateway that heard D inside the coverage window
// is itself in an active no_data alarm; a device with one live covering gateway never is.
const settings = require("../../config/settings");
const { knex, T, nowEpoch } = require("../../db/knex");
const alarmsRepo = require("../../db/repos/alarms");
const engine = require("./engine");
const armed = require("./armed");
const logger = require("../../config/logger");

async function gatewayNoDataAlarm(gatewayId)
{
    return knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id")
        .where("s.device_id", gatewayId).where("a.direction", "no_data").whereNull("a.cleared_epoch").select("a.*").first();
}

async function suppressionFor(device, now)
{
    if (device.kind === "gateway") { return null; }
    const since = now - settings.get("COVERAGE_WINDOW_HOURS", 24) * 3600;
    const covering = await knex(T("device_coverage")).where({ device_id: device.id }).where("last_heard_epoch", ">=", since);
    if (covering.length === 0) { return null; }
    let firstGatewayAlarm = null;
    for (const c of covering)
    {
        const ga = await gatewayNoDataAlarm(c.gateway_id);
        if (!ga) { return null; }                 // a live covering gateway exists: never suppress
        if (!firstGatewayAlarm) { firstGatewayAlarm = ga; }
    }
    return firstGatewayAlarm.id;
}

async function run()
{
    const now = nowEpoch();
    const rules = await knex(T("alarm_rules") + " as r")
        .join(T("sensors") + " as s", "s.id", "r.sensor_id")
        .join(T("devices") + " as d", "d.id", "s.device_id")
        .join(T("locations") + " as l", "l.id", "d.location_id")
        .where({ "r.rule_kind": "no_data", "r.is_enabled": 1 })
        .whereNull("r.delete_epoch").whereNull("s.delete_epoch").whereNull("d.delete_epoch")
        .where("d.is_archived", 0).where("s.is_enabled", 1).where("s.is_hidden", 0)
        .select("r.*", "s.last_epoch", "s.created_epoch as sensor_created", "d.id as device_id", "d.kind", "d.is_offline", "d.is_archived", "d.name as device_name", "l.iana_timezone", "l.alarm_mode");

    for (const r of rules)
    {
        const device = { id: r.device_id, kind: r.kind, is_offline: r.is_offline, is_archived: r.is_archived, location_id: null };
        const active = await alarmsRepo.activeForSensor(r.sensor_id, "no_data");
        const disarmed = await armed.disarmReason(device, r, now, r.iana_timezone, { alarm_mode: r.alarm_mode });
        if (disarmed)
        {
            if (active) { await engine.clear(active, now, "disarmed", null, "disarmed: " + disarmed); }
            continue;
        }
        // Never heard: the clock starts at sensor creation ("waiting for first data" grace).
        const last = r.last_epoch || r.sensor_created;
        const silent = now - last >= r.timeout_secs;

        if (!silent)
        {
            // Data returned but the pipeline did not see this sensor (e.g. cleared elsewhere): tidy up.
            if (active) { await engine.clear(active, now, "returned"); }
            continue;
        }
        if (active)
        {
            // Suppressed alarm whose gateway recovered: lift suppression and notify, or clear if data came back.
            if (active.suppressed_by)
            {
                const still = await suppressionFor(device, now);
                if (!still)
                {
                    await knex(T("alarms")).where({ id: active.id }).update({ suppressed_by: null });
                    const eventId = await alarmsRepo.insertEvent({ alarm_id: active.id, epoch: now, event_kind: "raised", severity: active.severity, actor_type: "system", comment: "suppression lifted, gateway recovered" });
                    await engine.startLadders(active.id, now);
                    await require("./notify").notify(active.id, { eventId: eventId, eventKind: "raised", severity: active.severity });
                }
            }
            continue;
        }
        const suppressedBy = await suppressionFor(device, now);
        await engine.raise({ id: r.sensor_id, device_id: r.device_id }, "no_data", r, r.severity, null, now, { suppressedBy: suppressedBy });
        logger.info({ sensor: r.sensor_id, device: r.device_name, suppressed: !!suppressedBy }, "no_data raised");
    }
}

// Devices silent behind an offline gateway, for the location roll up and the gateway email.
async function suppressedCount(gatewayAlarmId)
{
    const r = await knex(T("alarms")).where({ suppressed_by: gatewayAlarmId }).whereNull("cleared_epoch").count("id as n").first();
    return Number(r.n);
}

module.exports = { run, suppressionFor, suppressedCount };
