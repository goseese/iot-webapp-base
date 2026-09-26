// Data for a location's dashboard: tiles, sensors tagged "dashboard", recent active alarms.
const { knex, T, nowEpoch } = require("../db/knex");
const settings = require("../config/settings");
const display = require("./display");

async function forLocation(location)
{
    const now = nowEpoch();
    const threshold = settings.get("ONLINE_THRESHOLD_SECS", 900);
    const devs = await knex(T("devices")).where({ location_id: location.id }).whereNull("delete_epoch").where("is_archived", 0).select("kind", "last_seen_epoch", "is_offline");
    const tiles =
    {
        devices: devs.filter((d) => d.kind !== "gateway").length,
        gateways: devs.filter((d) => d.kind === "gateway").length,
        silent: devs.filter((d) => !d.is_offline && (!d.last_seen_epoch || now - Number(d.last_seen_epoch) > threshold)).length,
        alarms: Number((await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id").where("d.location_id", location.id).whereNull("a.cleared_epoch").count("a.id as n").first()).n)
    };
    const alarms = await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id")
        .where("d.location_id", location.id).whereNull("a.cleared_epoch").select("a.*", "s.name as sensor_name", "s.uid as sensor_uid", "d.name as device_name").orderBy("a.raised_epoch", "desc").limit(10);
    const tagged = await knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id")
        .where("d.location_id", location.id).whereNull("s.delete_epoch").whereNull("d.delete_epoch").where("d.is_archived", 0).where("s.is_hidden", 0)
        .where(function ()
        {
            this.whereExists(knex(T("taggings") + " as tg").join(T("tags") + " as t", "t.id", "tg.tag_id").whereRaw("tg.entity_type = 'sensor' AND tg.entity_id = s.id AND t.name = 'dashboard'"))
                .orWhere(function ()
                {
                    // Inherited from the device unless this sensor excludes it.
                    this.whereExists(knex(T("taggings") + " as tg").join(T("tags") + " as t", "t.id", "tg.tag_id").whereRaw("tg.entity_type = 'device' AND tg.entity_id = d.id AND t.name = 'dashboard'"))
                        .whereNotExists(knex(T("tag_exclusions") + " as tx").join(T("tags") + " as t", "t.id", "tx.tag_id").whereRaw("tx.entity_type = 'sensor' AND tx.entity_id = s.id AND t.name = 'dashboard'"));
                });
        })
        .select("s.*", "d.name as device_name", "d.uid as device_uid").orderBy(["d.name", "s.sort_order"]);
    for (const s of tagged)
    {
        s.display = await display.format(s, s.last_value, location);
        s.alarm = await knex(T("alarms")).where({ sensor_id: s.id }).whereNull("cleared_epoch").first();
    }
    return { tiles: tiles, alarms: alarms, sensors: tagged };
}

module.exports = { forLocation };
