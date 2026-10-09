const { knex, T, nowEpoch } = require("../db/knex");
const locationsRepo = require("../db/repos/locations");
const { audit } = require("./audit");

async function create(accountId, fields, actor)
{
    return knex.transaction(async (trx) =>
    {
        const id = await locationsRepo.insert(
        {
            account_id: accountId, name: fields.name, iana_timezone: fields.iana_timezone || "UTC",
            address: fields.address || null, lat: fields.lat === undefined ? null : fields.lat, lng: fields.lng === undefined ? null : fields.lng,
            notes: fields.notes || null, created_epoch: nowEpoch(), created_by: actor.id
        }, trx);
        const location = await trx(T("locations")).where({ id: id }).first();
        await audit(trx, { entityType: "location", entityUid: location.uid, entityName: location.name, field: "created", actorType: "user", actorId: actor.id, actorName: actor.username });
        return location;
    });
}

// Every field change audits (architecture 11).
async function update(location, patch, actor)
{
    await knex.transaction(async (trx) =>
    {
        for (const [field, value] of Object.entries(patch))
        {
            if (String(location[field]) !== String(value))
            {
                await audit(trx, { entityType: "location", entityUid: location.uid, entityName: location.name, field: field, oldValue: location[field], newValue: value, actorType: "user", actorId: actor.id, actorName: actor.username });
            }
        }
        await trx(T("locations")).where({ id: location.id }).update(patch);
    });
}

async function softDelete(location, actor)
{
    const now = nowEpoch();
    await knex.transaction(async (trx) =>
    {
        const devices = await trx(T("devices")).where({ location_id: location.id }).whereNull("delete_epoch").select("id");
        const ids = devices.map((d) => d.id);
        if (ids.length > 0)
        {
            // Rules are soft deleted and logged too, so they can be restored with the location.
            await require("./alarms/ruleLog").deleteForSensors(trx, trx(T("sensors")).whereIn("device_id", ids).whereNull("delete_epoch").select("id"), { actorType: "user", actorId: actor.id, actorName: actor.username }, "location deleted", now);
            await trx(T("sensors")).whereIn("device_id", ids).whereNull("delete_epoch").update({ delete_epoch: now });
            // Units behind these devices keep their credentials (migration 0020); only placements end.
            await trx(T("devices")).whereIn("id", ids).update({ delete_epoch: now });
        }
        await trx(T("locations")).where({ id: location.id }).update({ delete_epoch: now });
        await audit(trx, { entityType: "location", entityUid: location.uid, entityName: location.name, field: "deleted", newValue: ids.length + " devices", actorType: "user", actorId: actor.id, actorName: actor.username });
    });
}

// active | muted | offline. Muted keeps evaluating and records alarms but notifies nobody;
// offline stops evaluation entirely and clears the location's active alarms.
async function setAlarmMode(location, mode, actor)
{
    if (!["active", "muted", "offline"].includes(mode)) { throw new Error("bad alarm mode"); }
    await update(location, { alarm_mode: mode, notifications_muted: mode === "active" ? 0 : 1 }, actor);
    if (mode === "offline")
    {
        const engine = require("./alarms/engine");
        const devices = await knex(T("devices")).where({ location_id: location.id }).whereNull("delete_epoch").select("id");
        for (const d of devices) { await engine.clearAllForDevice(d.id, nowEpoch(), "disarmed", { type: "user", id: actor.id }, "cleared: location set offline"); }
    }
}

async function counts(locationId)
{
    const dev = await knex(T("devices")).where({ location_id: locationId, is_archived: 0 }).whereNull("delete_epoch").select("kind", "is_offline", "last_seen_epoch");
    const active = await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id")
        .where("d.location_id", locationId).whereNull("a.cleared_epoch").count("a.id as n").first();
    return {
        gateways: dev.filter((d) => d.kind === "gateway").length,
        devices: dev.filter((d) => d.kind !== "gateway").length,
        offline: dev.filter((d) => d.is_offline).length,
        alarms: Number(active.n)
    };
}

// Gateways and devices per location for the account pages, archived and deleted ones left out.
// Returns { locationId: { gateways, devices } }.
async function deviceCounts(locationIds)
{
    const out = {};
    for (const id of locationIds) { out[id] = { gateways: 0, devices: 0 }; }
    if (!locationIds.length) { return out; }
    const rows = await knex(T("devices")).whereIn("location_id", locationIds).where("is_archived", false).whereNull("delete_epoch")
        .groupBy("location_id", "kind").select("location_id", "kind").count("id as n");
    for (const r of rows)
    {
        const c = out[r.location_id];
        if (!c) { continue; }
        if (r.kind === "gateway") { c.gateways += Number(r.n); }
        else { c.devices += Number(r.n); }
    }
    return out;
}

module.exports = { create, update, setAlarmMode, softDelete, counts, deviceCounts };
