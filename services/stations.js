// Pod stations (DECISIONS.md "Pod stations"). A controller pod runs a station of up to about 19
// target pods (ESP-NOW peer limit 20, less the broadcast entry); a target pod reaches the server
// only through the controller it paired with, which relays its frames.
//
// Pairing is a deliberate act on site: someone turns on "Pair target pods" for a controller (the
// pair_mode config key, so the page shows what the pod actually holds), then holds a target pod's
// button until it pairs. Its first frame through a controller that reports pairing mode on:
//   - no placement yet: creates one in the controller's location, linked to that controller
//   - placed under another controller: moves it here, history and all (same physical pod)
// While pairing is off a new pod is only recorded as heard, so a pod deleted in the app does not
// come back just because it is still paired on the radio. At most one controller per location may
// be in pairing mode (Jeff, Sep 2026): two controllers pairing in range could both take a pod.
const logger = require("../config/logger");
const { knex, T } = require("../db/knex");
const deviceTypes = require("../deviceTypes");
const devicesRepo = require("../db/repos/devices");
const { audit } = require("./audit");

const PAIR_KEY = "pair_mode";

function truthy(v)
{
    return /^(1|true|yes|on)$/i.test(String(v === undefined || v === null ? "" : v).trim());
}

async function typeOf(device)
{
    const row = await knex(T("device_types")).where({ id: device.device_type_id }).first();
    try { return row ? deviceTypes.get(row.slug) : null; }
    catch (err) { return null; }
}

// { on, pending }: on is what the controller last reported; pending is the value a write from the
// page is waiting to be confirmed with (null when nothing is waiting).
async function pairingState(controller)
{
    if (!controller || !controller.hardware_id) { return { on: false, pending: null }; }
    const row = await knex(T("unit_config")).where({ mac: controller.hardware_id, config_key: PAIR_KEY }).first();
    return {
        on: !!row && truthy(row.reported_value),
        pending: row && row.desired_value !== null && row.desired_value !== undefined ? truthy(row.desired_value) : null
    };
}

// Another controller at this location that is pairing, or has been asked to start. null if none.
async function pairingElsewhere(locationId, exceptDeviceId)
{
    const rows = await knex(T("devices") + " as d")
        .join(T("device_types") + " as dt", "dt.id", "d.device_type_id")
        .join(T("unit_config") + " as c", function () { this.on("c.mac", "=", "d.hardware_id").andOn("c.config_key", "=", knex.raw("?", [PAIR_KEY])); })
        .where("d.location_id", locationId)
        .whereNot("d.id", exceptDeviceId)
        .whereNull("d.delete_epoch")
        .where("d.is_archived", false)
        .select("d.id", "d.uid", "d.name", "dt.slug", "c.reported_value", "c.desired_value");
    return rows.find((r) => deviceTypes.all[r.slug] && deviceTypes.all[r.slug].station && (truthy(r.reported_value) || truthy(r.desired_value))) || null;
}

// The controller's target pods, for its page, with the signal the controller last heard each at.
async function roster(controllerId)
{
    const rows = await knex(T("devices") + " as d")
        .leftJoin(T("device_types") + " as dt", "dt.id", "d.device_type_id")
        .leftJoin(T("device_coverage") + " as c", function () { this.on("c.device_id", "=", "d.id").andOn("c.gateway_id", "=", knex.raw("?", [controllerId])); })
        .where("d.controller_id", controllerId)
        .whereNull("d.delete_epoch")
        .where("d.is_archived", false)
        .select("d.id", "d.uid", "d.name", "d.hardware_id", "d.model", "d.firmware", "d.last_seen_epoch", "d.created_epoch", "dt.display_name as type_name", "c.last_rssi")
        .orderBy("d.created_epoch", "asc");
    rows.forEach((r) => { r.signal_pct = require("./levels").signalPercent("wifi", r.last_rssi); });
    return rows;
}

function defaultName(podType, mac)
{
    return (podType.namePrefix || podType.displayName) + " " + mac.slice(-4);
}

// Tell the controller's open page (and the old controller's, after a move) to refresh its station
// panel: the same config notice the Config tab uses, device uid only.
async function notify(controller)
{
    if (controller && controller.hardware_id) { await require("./unitConfig").notifyMac(controller.hardware_id); }
}

// From ingest (pipeline/identify.js handleFrame), before the frame is stored. Returns the target
// pod's placement if pairing just created or moved it, else null (nothing to do).
async function placeFromFrame(controller, device, header)
{
    const podType = deviceTypes.forModel(header.model);
    if (!podType || !(podType.pairsWith || []).length) { return null; }
    if (device && device.controller_id === controller.id) { return null; }
    const ctlType = await typeOf(controller);
    if (!ctlType || !podType.pairsWith.includes(ctlType.slug)) { return null; }
    if (!(await pairingState(controller)).on) { return null; }

    const activity = require("./activity");
    const location = await knex(T("locations")).where({ id: controller.location_id }).first();
    const ctx = { channel: "mqtt", correlationId: activity.newCorrelationId(), accountId: location ? location.account_id : null };

    if (!device)
    {
        const created = await require("./devices").create(
        {
            locationId: controller.location_id, typeSlug: podType.slug, name: defaultName(podType, header.mac),
            hardwareId: header.mac, model: header.model || null, firmware: header.firmware || null, createdBy: null
        });
        await knex.transaction(async (trx) =>
        {
            await trx(T("devices")).where({ id: created.id }).update({ controller_id: controller.id });
            await audit(trx, { entityType: "device", entityUid: created.uid, entityName: created.name, field: "controller", oldValue: null, newValue: controller.name, actorType: "system" });
        });
        await activity.record("pod_paired", { entity_type: "device", entity_uid: created.uid, detail: header.mac + " paired with " + controller.name }, ctx);
        logger.info({ mac: header.mac, controller: controller.uid, device: created.uid }, "target pod paired: placement created");
        await notify(controller);
        return devicesRepo.findById(created.id);
    }

    const from = device.controller_id ? await devicesRepo.findById(device.controller_id) : null;
    const fromLocation = await knex(T("locations")).where({ id: device.location_id }).first();
    await knex.transaction(async (trx) =>
    {
        await trx(T("devices")).where({ id: device.id }).update({ controller_id: controller.id, location_id: controller.location_id });
        await audit(trx, { entityType: "device", entityUid: device.uid, entityName: device.name, field: "controller", oldValue: from ? from.name : null, newValue: controller.name, actorType: "system" });
        if (device.location_id !== controller.location_id)
        {
            await audit(trx, { entityType: "device", entityUid: device.uid, entityName: device.name, field: "location", oldValue: fromLocation ? fromLocation.name : null, newValue: location ? location.name : null, actorType: "system" });
        }
    });
    await activity.record("pod_moved", { entity_type: "device", entity_uid: device.uid, detail: header.mac + " moved to " + controller.name + (from ? " from " + from.name : "") }, ctx);
    logger.info({ mac: header.mac, controller: controller.uid, from: from ? from.uid : null, device: device.uid }, "target pod paired: moved to this station");
    await notify(controller);
    if (from) { await notify(from); }
    return devicesRepo.findById(device.id);
}

module.exports = { PAIR_KEY, truthy, pairingState, pairingElsewhere, roster, placeFromFrame, typeOf };
