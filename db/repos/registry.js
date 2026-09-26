const { knex, T, isUniqueViolation } = require("../knex");

// First contact inserts; every later contact updates. Rows are never deleted (architecture 3.8).
async function touch(mac, info)
{
    const existing = await knex(T("device_registry")).where({ mac: mac }).first();
    if (existing)
    {
        const patch = { last_heard_epoch: info.epoch };
        if (info.firmware) { patch.last_firmware = info.firmware; }
        if (info.deviceUid) { patch.last_device_uid = info.deviceUid; }
        await knex(T("device_registry")).where({ id: existing.id }).update(patch);
        return existing;
    }
    try
    {
        await knex(T("device_registry")).insert(
        {
            mac: mac,
            first_model: info.model || null,
            first_firmware: info.firmware || null,
            first_heard_epoch: info.epoch,
            first_heard_via: info.via,
            last_firmware: info.firmware || null,
            last_heard_epoch: info.epoch,
            last_device_uid: info.deviceUid || null
        });
    }
    catch (err) { if (!isUniqueViolation(err)) { throw err; } }
    return knex(T("device_registry")).where({ mac: mac }).first();
}

function findByMac(mac) { return knex(T("device_registry")).where({ mac: mac }).first(); }

// MACs heard that belong to no live device: the superadmin unknown devices list. A superadmin
// ignore (DTM_unclaimed_ignored, account_id NULL) hides a MAC unless showIgnored; rows carry
// is_ignored either way.
function listUnknown(showIgnored)
{
    const q = knex(T("device_registry") + " as r")
        .leftJoin(T("devices") + " as d", function () { this.on("d.hardware_id", "r.mac").andOnNull("d.delete_epoch").andOn("d.is_archived", knex.raw("false")); })
        .leftJoin(T("unclaimed_ignored") + " as i", function () { this.on("i.mac", "r.mac").andOnNull("i.account_id"); })
        .whereNull("d.id")
        .select("r.*", knex.raw("CASE WHEN i.id IS NULL THEN 0 ELSE 1 END AS is_ignored"))
        .orderBy("r.last_heard_epoch", "desc");
    if (!showIgnored) { q.whereNull("i.id"); }
    return q;
}

// Which gateway placement heard an unplaced MAC, last time and RSSI: one row per MAC and gateway,
// shaped like readings.upsertCoverage (DECISIONS "Unclaimed devices, per account").
async function heardBy(mac, gatewayId, epoch, rssi)
{
    const row = { last_heard_epoch: epoch, last_rssi: rssi === undefined || rssi === null || !Number.isFinite(Number(rssi)) ? null : Number(rssi) };
    const updated = await knex(T("unclaimed_heard")).where({ mac: mac, gateway_id: gatewayId }).update(row);
    if (updated === 0)
    {
        try { await knex(T("unclaimed_heard")).insert(Object.assign({ mac: mac, gateway_id: gatewayId }, row)); }
        catch (err) { if (!isUniqueViolation(err)) { throw err; } }
    }
}

module.exports = { touch, findByMac, listUnknown, heardBy };
