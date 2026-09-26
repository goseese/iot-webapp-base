// Boot time upsert of code declared device types; refuses to boot if the DB references a
// type whose module is gone (conventions.md section 3).
const { knex, T } = require("./knex");
const deviceTypes = require("../deviceTypes");

async function syncDeviceTypes(log)
{
    for (const t of Object.values(deviceTypes.all))
    {
        const row =
        {
            display_name: t.displayName,
            kind: t.kind,
            dedup_mode: t.dedupMode,
            min_interval_secs: t.minIntervalSecs || 0,
            models: (t.models || []).join(",") || null
        };
        const existing = await knex(T("device_types")).where({ slug: t.slug }).first();
        if (existing) { await knex(T("device_types")).where({ id: existing.id }).update(row); }
        else { await knex(T("device_types")).insert(Object.assign({ slug: t.slug }, row)); }
    }

    const orphans = await knex(T("device_types") + " as dt")
        .join(T("devices") + " as d", "d.device_type_id", "dt.id")
        .whereNull("d.delete_epoch")
        .whereNotIn("dt.slug", Object.keys(deviceTypes.all))
        .distinct("dt.slug");
    if (orphans.length > 0)
    {
        throw new Error("devices reference device types with no module: " + orphans.map((o) => o.slug).join(", "));
    }
    if (log) { log.info({ types: Object.keys(deviceTypes.all) }, "device types shadowed"); }
}

module.exports = { syncDeviceTypes };
