const { knex, T } = require("../db/knex");

module.exports =
{
    slug: "alarm_history",
    displayName: "Alarm history",
    description: "Every alarm raised in the window with its severity, timing and how it cleared.",
    columns: ["Location", "Device", "Sensor", "Direction", "Severity", "Raised", "Cleared", "Duration (min)", "Clear reason", "Acknowledged by"],
    async rows(q)
    {
        const rows = await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id").leftJoin(T("users") + " as u", "u.id", "a.acked_by")
            .whereIn("s.id", q.sensorIds).where("a.raised_epoch", ">=", q.fromEpoch).where("a.raised_epoch", "<=", q.toEpoch)
            .select("a.*", "s.name as sensor_name", "d.name as device_name", "l.name as location_name", "l.iana_timezone", "u.username").orderBy("a.raised_epoch");
        return rows.map((a) => [a.location_name, a.device_name, a.sensor_name, a.direction, a.severity,
            new Date(Number(a.raised_epoch) * 1000).toLocaleString("en-US", { timeZone: a.iana_timezone }),
            a.cleared_epoch ? new Date(Number(a.cleared_epoch) * 1000).toLocaleString("en-US", { timeZone: a.iana_timezone }) : "active",
            a.cleared_epoch ? Math.round((Number(a.cleared_epoch) - Number(a.raised_epoch)) / 60) : "", a.clear_reason || "", a.username || ""]);
    }
};
