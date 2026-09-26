// Scheduled ends of offline periods (architecture 8.3): flips is_offline back on and off.
const { knex, T, nowEpoch } = require("../../db/knex");
const engine = require("../../services/alarms/engine");

async function run()
{
    const now = nowEpoch();
    const devices = await knex(T("devices")).whereNull("delete_epoch").select("id", "is_offline");
    for (const d of devices)
    {
        const open = await knex(T("offline_periods")).where({ device_id: d.id }).where("start_epoch", "<=", now)
            .where(function () { this.whereNull("end_epoch").orWhere("end_epoch", ">", now); }).first();
        const shouldBeOffline = !!open;
        if (shouldBeOffline !== !!d.is_offline)
        {
            await knex(T("devices")).where({ id: d.id }).update({ is_offline: shouldBeOffline ? 1 : 0 });
            if (shouldBeOffline) { await engine.clearAllForDevice(d.id, now, "offline", null, "cleared, device set offline"); }
        }
    }
}

module.exports = { run };
