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
const { knex, T, nowEpoch } = require("../db/knex");
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

// A controller's function button asked to pair: dev/{guid}/event {"event":"pair_request"}
// (pod-protocol.md 6.3). The pod waits, LEDs breathing blue, pairing nothing until answered. The
// answer is a plain pair_mode config write, the same path as the web toggle: true when no other
// controller at its location is pairing or has it pending, else false, which the waiting pod takes
// as the refusal. A pod with no placement is refused. The check and the write run under a per
// location lock, which the web toggle takes too (pairIfFree), so no two requests can both be granted. Each request is recorded
// in the event log (granted or refused, naming the blocking controller); the Station tab shows a
// recent refusal. Returns { granted, reason }.
const PAIRING_LOCK = 7306;

// Runs fn() holding the location's pairing lock: every "turn pairing on" decision (web toggle,
// Config tab, button) checks pairingElsewhere and writes pair_mode inside it, so none can pass the
// check while another is between its check and its write.
function withPairingLock(locationId, fn)
{
    return knex.transaction(async (trx) =>
    {
        await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [PAIRING_LOCK, locationId]);
        return fn();
    });
}

// From the web toggle and the Config tab: pair_mode true unless another controller at the location
// is pairing or pending. { blocker } when refused, else { result } of the config write.
function pairIfFree(controller, guid, typeModule, userId)
{
    return withPairingLock(controller.location_id, async () =>
    {
        const blocker = await pairingElsewhere(controller.location_id, controller.id);
        if (blocker) { return { blocker: blocker }; }
        return { result: await require("./unitConfig").write(controller.hardware_id, guid, PAIR_KEY, "true", typeModule, userId) };
    });
}

async function buttonRequest(controller, mac, guid, typeModule)
{
    const unitConfig = require("./unitConfig");
    const activity = require("./activity");
    let granted = false;
    let reason = null;
    if (!controller)
    {
        reason = "the pod is not placed at any location";
        await unitConfig.write(mac, guid, PAIR_KEY, "false", typeModule, null);
    }
    else
    {
        await withPairingLock(controller.location_id, async () =>
        {
            const blocker = await pairingElsewhere(controller.location_id, controller.id);
            granted = !blocker;
            if (blocker) { reason = blocker.name + " at this location is already pairing"; }
            await unitConfig.write(mac, guid, PAIR_KEY, granted ? "true" : "false", typeModule, null);
        });
    }
    const ctx = { channel: "mqtt", correlationId: activity.newCorrelationId() };
    if (controller)
    {
        const location = await knex(T("locations")).where({ id: controller.location_id }).first();
        ctx.accountId = location ? location.account_id : null;
    }
    await activity.record("pair_request",
    {
        entity_type: controller ? "device" : "unit", entity_uid: controller ? controller.uid : guid,
        outcome: granted ? "granted" : "refused", detail: granted ? "pairing started from the button" : "refused: " + reason
    }, ctx);
    logger.info({ mac: mac, controller: controller ? controller.uid : null, granted: granted, reason: reason }, "pairing button request");
    return { granted: granted, reason: reason };
}

// The controller went offline ({"online":false} on dev/{guid}/status: its last will, or its own
// publish before a clean disconnect). A dead or unplugged controller must not stay "pairing" on the
// server: that shows a false banner and blocks every other controller at its location. So pairing
// that is on or pending ends here: reported false (it cannot pair targets the server would hear
// while offline) and false pending, which reaches the controller when it next connects. Runs for
// the live message and for the stored copy the broker replays, since that is the current state.
// Returns true when pairing was ended.
async function wentOffline(controller, typeModule)
{
    if (!typeModule || !typeModule.station || !controller.hardware_id) { return false; }
    const row = await knex(T("unit_config")).where({ mac: controller.hardware_id, config_key: PAIR_KEY }).first();
    if (!row || !(truthy(row.reported_value) || truthy(row.desired_value))) { return false; }
    const now = nowEpoch();
    await knex(T("unit_config")).where({ id: row.id }).update({ reported_value: "false", reported_epoch: now, desired_value: "false", desired_epoch: now, desired_by: null, sent_epoch: null });
    const activity = require("./activity");
    const location = await knex(T("locations")).where({ id: controller.location_id }).first();
    await activity.record("pairing_off", { entity_type: "device", entity_uid: controller.uid, detail: "pairing ended: the controller went offline" }, { channel: "mqtt", correlationId: activity.newCorrelationId(), accountId: location ? location.account_id : null });
    logger.info({ controller: controller.uid }, "pairing ended: controller went offline");
    await notify(controller);
    return true;
}

// The last button request of this controller if it was refused within sinceSecs, for its Station
// tab: { epoch, detail } or null.
async function lastButtonRefusal(controller, sinceSecs)
{
    const row = await knex(T("event_log")).where({ event: "pair_request" })
        .where("time", ">=", (nowEpoch() - sinceSecs) * 1000)
        .whereRaw("details->>'entity_uid' = ?", [String(controller.uid)])
        .orderBy("time", "desc").first();
    return row && row.details && row.details.outcome === "refused" ? { epoch: Math.floor(Number(row.time) / 1000), detail: row.details.detail } : null;
}

module.exports = { PAIR_KEY, truthy, pairingState, pairingElsewhere, roster, placeFromFrame, typeOf, pairIfFree, buttonRequest, wentOffline, lastButtonRefusal };
