const { knex, T, insertId } = require("../knex");

function rulesForSensor(sensorId, trx)
{
    return (trx || knex)(T("alarm_rules")).where({ sensor_id: sensorId, is_enabled: 1 }).whereNull("delete_epoch");
}

function saveRuleClocks(rule, trx)
{
    return (trx || knex)(T("alarm_rules")).where({ id: rule.id }).update({ breach_since: rule.breach_since, return_since: rule.return_since });
}

function activeForSensor(sensorId, direction, trx)
{
    return (trx || knex)(T("alarms")).where({ sensor_id: sensorId, direction: direction }).whereNull("cleared_epoch").first();
}

function activeForDevice(deviceId, trx)
{
    return (trx || knex)(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id")
        .where("s.device_id", deviceId).whereNull("a.cleared_epoch").select("a.*");
}

async function insertAlarm(row, trx)
{
    const r = await (trx || knex)(T("alarms")).insert(row).returning("id");
    return insertId(r);
}

function updateAlarm(id, patch, trx) { return (trx || knex)(T("alarms")).where({ id: id }).update(patch); }

async function insertEvent(row, trx)
{
    const r = await (trx || knex)(T("alarm_events")).insert(row).returning("id");
    return insertId(r);
}

function findByUid(uid) { return knex(T("alarms")).where({ uid: uid }).first(); }
function findById(id) { return knex(T("alarms")).where({ id: id }).first(); }

// Alarm with sensor, device, location and account context for notifications and pages.
function context(alarmId)
{
    return knex(T("alarms") + " as a")
        .join(T("sensors") + " as s", "s.id", "a.sensor_id")
        .join(T("devices") + " as d", "d.id", "s.device_id")
        .join(T("locations") + " as l", "l.id", "d.location_id")
        .join(T("accounts") + " as ac", "ac.id", "l.account_id")
        .where("a.id", alarmId)
        .select("a.*", "s.uid as sensor_uid", "s.name as sensor_name", "s.metric", "s.display_unit", "s.display_precision", "s.channel_id", "s.alarm_title as sensor_alarm_title",
                "d.id as device_id", "d.uid as device_uid", "d.name as device_name", "d.kind as device_kind", "d.alarm_title as device_alarm_title",
                "l.id as location_id", "l.uid as location_uid", "l.name as location_name", "l.iana_timezone", "l.notifications_muted as location_muted",
                "ac.id as account_id", "ac.uid as account_uid", "ac.name as account_name", "ac.notifications_muted as account_muted")
        .first();
}

// Events that draw alarm markers on a sensor chart (public/js/iot-sensor-chart.js alarmMarkers):
// raises, escalations, lowerings, clears and suppressions of the sensor's alarms that overlap
// [from, to] (epoch seconds), oldest first. Events before from are kept so a lowering knows the
// level it left; nothing after to.
function markerEvents(sensorId, from, to)
{
    return knex(T("alarm_events") + " as e").join(T("alarms") + " as a", "a.id", "e.alarm_id")
        .where("a.sensor_id", sensorId).where("a.raised_epoch", "<=", to)
        .where(function () { this.whereNull("a.cleared_epoch").orWhere("a.cleared_epoch", ">=", from); })
        .whereIn("e.event_kind", ["raised", "escalated", "de_escalated", "cleared", "suppressed"])
        .where("e.epoch", "<=", to)
        .orderBy([{ column: "e.epoch" }, { column: "e.id" }])
        .select("a.uid", "e.epoch", "e.event_kind", "e.severity");
}

module.exports = { rulesForSensor, saveRuleClocks, activeForSensor, activeForDevice, insertAlarm, updateAlarm, insertEvent, findByUid, findById, context, markerEvents };
