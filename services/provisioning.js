// Provisioning (architecture 7.3, gateway-protocol 2) under the active broker driver. With the
// static driver the response carries the GUID and no password; the gateway keeps its shared
// credential and moves to dev/{guid}/#. A dynsec driver receives the per device ACLs from
// mqtt/topics.deviceAcls (publish own uplinks, subscribe own cmd).
const crypto = require("crypto");
const logger = require("../config/logger");
const { knex, T, nowEpoch, isUniqueViolation } = require("../db/knex");
const registry = require("../db/repos/registry");
const broker = require("./broker");
const topics = require("../mqtt/topics");
const activity = require("./activity");
const credentials = require("../db/repos/credentials");
const deviceTypes = require("../deviceTypes");

function normalizeMac(mac)
{
    return String(mac || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

// A claim older than this is treated as abandoned (a process that died mid issue) and can be taken
// over. Comfortably above the worst case for the broker round trips, each of which waits up to 10 s
// in services/broker/dynsec.js.
const CLAIM_STALE_SECS = 60;

// The unit's device type comes from its model string: each deviceTypes module lists the models it
// covers in `models`, and deviceTypes.forModel() finds the module (exact match). The type must be
// for hardware that connects to the broker itself. Nodes, beacons and assets never hold broker
// credentials, and platform_server is the server's own pseudo device: kind "direct" like a real
// direct device, but it must never provision. Supporting a new product means adding its model
// string to a type module; until then its units are refused with 400.
function resolveType(model)
{
    if (typeof model !== "string" || model.trim() === "") { return { reason: "missing_model" }; }
    const type = deviceTypes.forModel(model.trim());
    if (!type || type.slug === "platform_server") { return { reason: "unknown_model" }; }
    if (type.kind !== "gateway" && type.kind !== "direct") { return { reason: "unknown_model" }; }
    return { slug: type.slug };
}

// Creates or refreshes the unit's broker account and activates a credential row this request has
// claimed (state "issuing"). On a broker failure the row goes back to pending, keeping its GUID, so
// the device's retry goes through the pending case with the same identity.
async function activate(cred, guid, now)
{
    const driver = broker.active();
    let password = null;
    try
    {
        const user = await driver.createDeviceUser(guid, topics.deviceAcls(guid));
        password = user.password;
    }
    catch (err)
    {
        await knex(T("device_credentials")).where({ id: cred.id, state: "issuing" }).update({ state: "pending", activated_epoch: null });
        logger.error({ mac: cred.mac, unit: guid, err: err.message }, "broker account could not be created; left pending for the retry");
        throw err;
    }
    const settingsSvc = require("../config/settings");
    await knex(T("device_credentials")).where({ id: cred.id, state: "issuing" }).update(
    {
        state: "active",
        activated_epoch: now,
        broker_password_enc: password ? settingsSvc.encrypt(password) : null,
        // The account was just created and read back by createDeviceUser, so any fault the last
        // audit recorded describes an account that no longer exists.
        broker_fault: null
    });
    return password;
}

// HTTPS first contact, called by routes/provision.js. Returns what the endpoint should answer.
//
// Works on the UNIT (migration 0020): identity belongs to the hardware, not to a placement, so a
// unit can be issued credentials before anyone adds it to a location, and keeps them when it is
// removed from one. Three cases, by what the server holds for this MAC:
//
//   no live credential      first contact: new unit GUID, broker account, guid + password
//   credential pending      after Reprovision or lost flash: fresh password, SAME guid
//   credential active       { existing: true, guid }: keep the credentials you have. Also how a
//                           person troubleshooting sees which GUID a unit believes it has.
//
// The broker account is always created before the row is activated, so a device is never handed a
// password for an account that does not exist. Refusals return { ok: false, reason }; only broker
// and database failures throw, and the route turns those into a 500 the device retries.
async function issue(req)
{
    const mac = normalizeMac(req.hw || req.mac);
    if (mac.length !== 12) { return { ok: false, reason: "bad_hardware_id" }; }
    const resolved = resolveType(req.model);
    if (!resolved.slug) { return { ok: false, reason: resolved.reason }; }
    const typeSlug = resolved.slug;
    const now = nowEpoch();

    const placement = await credentials.currentPlacement(mac);
    await registry.touch(mac, { epoch: now, model: req.model, firmware: req.fw, via: "provision", deviceUid: placement ? placement.uid : null });

    let cred = await credentials.forMac(mac);

    // First contact. Inserting the row in state "issuing" IS the claim: the unique index on the MAC
    // among live rows lets exactly one concurrent request win. A loser re-reads the winner's row and
    // is handled like any other existing unit below.
    if (!cred)
    {
        const guid = crypto.randomUUID();
        try
        {
            await knex(T("device_credentials")).insert(
            {
                mac: mac,
                state: "issuing",
                broker_username: guid,
                type_slug: typeSlug,
                created_epoch: now,
                activated_epoch: now
            });
        }
        catch (err)
        {
            if (!isUniqueViolation(err)) { throw err; }
        }
        const mine = await credentials.forMac(mac);
        if (mine && mine.broker_username === guid)
        {
            const password = await activate(mine, guid, now);
            await activity.record("unit_provisioned", { actor_type: "anonymous", actor_name: mac, entity_type: "unit", entity_uid: guid, detail: "first contact, type " + typeSlug + ", driver " + broker.active().name }, { channel: "device", correlationId: req.correlationId });
            logger.info({ mac: mac, unit: guid, type: typeSlug, placed: !!placement }, "unit provisioned, first contact");
            return { ok: true, guid: guid, password: password };
        }
        cred = mine;
    }

    const guid = String(cred.broker_username).toLowerCase();

    if (cred.state === "active")
    {
        if (cred.type_slug && cred.type_slug !== typeSlug)
        {
            logger.warn({ mac: mac, unit: guid, stored: cred.type_slug, now: typeSlug, model: req.model }, "unit now reports a model of a different device type than it provisioned with");
        }
        logger.info({ mac: mac, unit: guid }, "provision request from an active unit; told to keep its credentials");
        return { ok: true, guid: guid, existing: true };
    }

    // Pending, or an abandoned claim: claim it with one conditional update. A fresh claim held by
    // another request means that request is issuing right now.
    const claimed = await knex(T("device_credentials"))
        .where({ id: cred.id })
        .whereNull("delete_epoch")
        .where(function ()
        {
            this.where("state", "pending")
                .orWhere(function () { this.where("state", "issuing").where("activated_epoch", "<", now - CLAIM_STALE_SECS); });
        })
        .update({ state: "issuing", activated_epoch: now, type_slug: cred.type_slug || typeSlug });
    if (Number(claimed) !== 1)
    {
        logger.warn({ mac: mac, unit: guid }, "provision request while another request is issuing");
        return { ok: false, reason: "in_progress", guid: guid };
    }

    const password = await activate(cred, guid, now);
    if (placement)
    {
        await knex(T("devices")).where({ id: placement.id }).update(
        {
            joined_epoch: placement.joined_epoch || now,
            model: req.model ? String(req.model).slice(0, 40) : placement.model,
            firmware: req.fw ? String(req.fw).slice(0, 24) : placement.firmware
        });
    }
    await activity.record("unit_provisioned", { actor_type: "anonymous", actor_name: mac, entity_type: "unit", entity_uid: guid, detail: "reissued, type " + typeSlug + ", driver " + broker.active().name }, { channel: "device", correlationId: req.correlationId });
    logger.info({ mac: mac, unit: guid, placed: !!placement }, "unit reissued");
    return { ok: true, guid: guid, password: password };
}

// Reprovision: revoke the unit's credentials so the firmware fallback kicks in. Deletes the broker
// account (the device's next login fails, so it returns to the HTTPS endpoint) and flips the row to
// pending, where the next request is issued a fresh password under the SAME GUID. broker_fault is
// cleared because the account it described is gone.
//
// Acts on the unit, not a placement, so it also works for a unit with no placement: the future
// unassociated devices page calls resetUnit(mac) directly.
async function resetUnit(mac)
{
    const cred = await credentials.forMac(mac);
    if (!cred) { return false; }
    const guid = String(cred.broker_username).toLowerCase();
    await broker.active().removeDeviceUser(guid);
    // Its retained status would stay on the broker for good (DECISIONS "Retained status cleanup").
    // Deleting the dynsec client kicks the unit without its will (mosquitto dynamic-security
    // clients.c, with_will false), so nothing republishes it after this. With no broker connection
    // the clear is only logged; the daily cleanup clears it later.
    const cleared = await require("../mqtt/downlink").clearRetained(topics.device.status(guid));
    await knex(T("device_credentials")).where({ id: cred.id }).update({ state: "pending", rotated_epoch: nowEpoch(), broker_password_enc: null, broker_fault: null, status_cleared_epoch: cleared ? nowEpoch() : null });
    logger.info({ mac: mac, unit: cred.broker_username }, "unit credentials revoked; pending reissue");
    return true;
}

// The device page's Reprovision button: the unit behind this placement.
async function reset(deviceId)
{
    const device = await knex(T("devices")).where({ id: deviceId }).first();
    const cred = await credentials.forDevice(device);
    if (!cred) { return false; }
    return resetUnit(cred.mac);
}

module.exports = { issue, reset, resetUnit, normalizeMac };
