const { knex, T } = require("../db/knex");
const metrics = require("../metrics");
const display = require("../services/display");

module.exports =
{
    slug: "readings_summary",
    displayName: "Readings summary",
    description: "Min, max, average and count per sensor over the window, in display units.",
    columns: ["Location", "Device", "Sensor", "Unit", "Min", "Max", "Average", "Readings", "Last"],
    async rows(q)
    {
        const out = [];
        for (const sensorId of q.sensorIds)
        {
            const s = await knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id").where("s.id", sensorId).select("s.*", "d.name as device_name", "l.name as location_name", "l.id as location_id", "l.account_id", "l.iana_timezone").first();
            if (!s) { continue; }
            const agg = await knex(T("readings")).where({ sensor_id: s.id }).where("epoch", ">=", q.fromEpoch).where("epoch", "<=", q.toEpoch).min("value as mn").max("value as mx").avg("value as av").count("id as n").first();
            const unit = await display.resolveUnit(s, { id: s.location_id, account_id: s.account_id });
            const p = metrics.precision(s.metric, unit);
            const f = (v) => v === null || v === undefined ? "" : metrics.fromCanonical(s.metric, Number(v), unit).toFixed(p);
            out.push([s.location_name, s.device_name, s.name, unit, f(agg.mn), f(agg.mx), f(agg.av), Number(agg.n), s.last_epoch ? new Date(Number(s.last_epoch) * 1000).toLocaleString("en-US", { timeZone: s.iana_timezone }) : ""]);
        }
        return out;
    }
};
