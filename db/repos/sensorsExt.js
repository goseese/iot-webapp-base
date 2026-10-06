// Sensor detail queries: readings window, rules, context with device/location/account.
const { knex, T } = require("../knex");

function context(uid)
{
    return knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id").join(T("device_types") + " as dt", "dt.id", "d.device_type_id")
        .where("s.uid", uid).whereNull("s.delete_epoch").whereNull("d.delete_epoch")
        .select("s.*", "d.uid as device_uid", "d.name as device_name", "d.alarm_title as device_alarm_title", "d.hardware_id as device_hardware_id", "d.kind as device_kind", "dt.slug as device_type_slug", "d.is_archived", "d.is_offline", "l.id as location_id", "l.uid as location_uid", "l.name as location_name", "l.account_id", "l.iana_timezone", "l.membership_mode")
        .first();
}

function readings(sensorId, fromEpoch, toEpoch, limit)
{
    return knex(T("readings")).where({ sensor_id: sensorId }).where("epoch", ">=", fromEpoch).where("epoch", "<=", toEpoch).orderBy("epoch").limit(limit || 5000).select("epoch", "value");
}

function rules(sensorId)
{
    return knex(T("alarm_rules")).where({ sensor_id: sensorId }).whereNull("delete_epoch").orderBy(["rule_kind", "direction", "threshold"]);
}

module.exports = { context, readings, rules };
