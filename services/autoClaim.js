// Auto claim membership mode (DECISIONS "Auto claim membership mode"). While a location is in
// auto_claim and its end time has not passed, a BLE beacon heard by a gateway placed there, whose
// MAC is on no live device and not ignored by the account, is added there by the system. Called
// from pipeline/identify.handleBle, so it runs only on the leader.
const { knex, T, nowEpoch } = require("../db/knex");
const { audit } = require("./audit");
const logger = require("../config/logger");
const devicesRepo = require("../db/repos/devices");
const deviceService = require("./devices");
const registry = require("../db/repos/registry");
const unclaimed = require("./unclaimed");

const HOURS = [1, 4, 12, 24];

// A NULL end time means no timeout (honoured here, not offered on the settings page).
function isActive(location, now)
{
    if (!location || location.membership_mode !== "auto_claim" || location.delete_epoch) { return false; }
    return location.auto_claim_until_epoch === null || Number(location.auto_claim_until_epoch) > (now || nowEpoch());
}

// Other locations in the account with an active auto claim (the settings page warning).
async function activeElsewhere(accountId, exceptLocationId)
{
    const rows = await knex(T("locations")).where({ account_id: accountId, membership_mode: "auto_claim" }).whereNull("delete_epoch").whereNot("id", exceptLocationId);
    const now = nowEpoch();
    return rows.filter((l) => isActive(l, now));
}

// gateway: the hearing gateway's device row. type: the beacon type module that parsed the
// advertisement. Returns the new device row, or null when nothing was claimed.
async function tryClaim(mac, type, gateway)
{
    if (gateway.is_archived || gateway.delete_epoch) { return null; }
    const location = await knex(T("locations")).where({ id: gateway.location_id }).first();
    if (!isActive(location)) { return null; }
    if (await unclaimed.isIgnored(location.account_id, mac)) { return null; }
    const name = unclaimed.defaultName(type, mac);
    let device;
    try
    {
        device = await deviceService.create({ locationId: location.id, typeSlug: type.slug, name: name, hardwareId: mac, model: type.slug, firmware: null, createdBy: null });
    }
    catch (err)
    {
        // Another location or gateway claimed it first (ux_DTM_devices_hardware_id): relay to it.
        if (err.number === 2601 || err.number === 2627) { return devicesRepo.findLiveByHardwareId(mac); }
        throw err;
    }
    await knex.transaction(async (trx) =>
    {
        await audit(trx, { entityType: "device", entityUid: device.uid, entityName: device.name, field: "auto_claimed", newValue: location.name + " via " + gateway.name, actorType: "system" });
    });
    await registry.touch(mac, { epoch: nowEpoch(), via: "ble", deviceUid: device.uid });
    await unclaimed.forget(mac);
    logger.info({ mac: mac, location: location.uid, gateway: gateway.uid, device: device.uid }, "auto claimed");
    return device;
}

// Minute job: locations whose auto claim has ended go back to normal, audited.
async function expire()
{
    const now = nowEpoch();
    const ended = await knex(T("locations")).where({ membership_mode: "auto_claim" }).whereNotNull("auto_claim_until_epoch").where("auto_claim_until_epoch", "<=", now).whereNull("delete_epoch");
    for (const l of ended)
    {
        await knex.transaction(async (trx) =>
        {
            await trx(T("locations")).where({ id: l.id, membership_mode: "auto_claim" }).update({ membership_mode: "normal", auto_claim_until_epoch: null });
            await audit(trx, { entityType: "location", entityUid: l.uid, entityName: l.name, field: "membership_mode", oldValue: "auto_claim", newValue: "normal", actorType: "system" });
        });
        logger.info({ location: l.uid }, "auto claim ended");
    }
}

module.exports = { HOURS, isActive, activeElsewhere, tryClaim, expire };
