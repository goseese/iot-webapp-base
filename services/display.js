// Display unit and precision resolution: sensor -> location -> account -> metric default
// (architecture 6.1). Keys in the scoped settings tables: DISPLAY_UNIT_<metric>.
const metrics = require("../metrics");
const { knex, T } = require("../db/knex");

const scopedCache = new Map();   // "location:5" -> { key: value }
const TTL = 60 * 1000;

async function scoped(table, col, id)
{
    const k = table + ":" + id;
    const hit = scopedCache.get(k);
    if (hit && Date.now() - hit.at < TTL) { return hit.map; }
    const rows = await knex(T(table)).where(col, id);
    const map = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
    scopedCache.set(k, { at: Date.now(), map: map });
    return map;
}

async function resolveUnit(sensor, location)
{
    const m = metrics.get(sensor.metric);
    if (sensor.display_unit) { return sensor.display_unit; }
    if (location)
    {
        const ls = await scoped("location_settings", "location_id", location.id);
        if (ls["DISPLAY_UNIT_" + sensor.metric]) { return ls["DISPLAY_UNIT_" + sensor.metric]; }
        const as = await scoped("account_settings", "account_id", location.account_id);
        if (as["DISPLAY_UNIT_" + sensor.metric]) { return as["DISPLAY_UNIT_" + sensor.metric]; }
    }
    return m.canonical;
}

async function format(sensor, value, location)
{
    if (value === null || value === undefined) { return "--"; }
    const unit = await resolveUnit(sensor, location);
    const precision = sensor.display_precision !== null && sensor.display_precision !== undefined ? sensor.display_precision : metrics.precision(sensor.metric, unit);
    const v = metrics.fromCanonical(sensor.metric, value, unit);
    if (sensor.metric === "boolean") { return v >= 0.5 ? "Yes" : "No"; }
    return v.toFixed(precision) + (unit ? " " + unit : "");
}

function invalidate() { scopedCache.clear(); }

module.exports = { resolveUnit, format, invalidate, scoped };
