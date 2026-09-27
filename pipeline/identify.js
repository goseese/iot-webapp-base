// Stage 1: topic -> gateway/device identity, registry, coverage, dedup claim (architecture 7.4,
// 7.5). Hands a { device, type, epoch, values } object to stages 2..6.
const settings = require("../config/settings");
const logger = require("../config/logger");
const { knex, T, nowEpoch } = require("../db/knex");
const deviceTypes = require("../deviceTypes");
const devicesRepo = require("../db/repos/devices");
const readingsRepo = require("../db/repos/readings");
const registry = require("../db/repos/registry");
const credentials = require("../db/repos/credentials");
const frames = require("./frames");
const topics = require("../mqtt/topics");
const pipeline = require("./index");

const typeSlugCache = new Map();   // device_type_id -> slug

async function typeForDevice(device)
{
    if (!typeSlugCache.has(device.device_type_id))
    {
        const row = await knex(T("device_types")).where({ id: device.device_type_id }).first();
        typeSlugCache.set(device.device_type_id, row ? row.slug : null);
    }
    const slug = typeSlugCache.get(device.device_type_id);
    return slug ? deviceTypes.get(slug) : null;
}

function connectsItself(device)
{
    return device && !device.is_archived && (device.kind === "gateway" || device.kind === "direct");
}

// Topic GUID -> the device row the data belongs to (migration 0020).
//
// The GUID in dev/{guid}/... is the UNIT's broker username, not a device row uid. The unit's data
// goes to its current placement: the one live, unarchived device row holding its MAC. A unit with no
// placement is unclaimed: it is connected with valid credentials and there is nowhere for its data
// to go, which is expected, not an error.
//
// Returns { gateway, unit }. gateway is null when there is nowhere to deliver.
async function resolve(guid)
{
    const unit = await credentials.forGuid(guid);
    if (!unit)
    {
        // No unit holds this GUID: hardware provisioned before the unit model, or not MAC identified
        // (host name or IMEI), whose topic GUID is still its device row uid. Unchanged behavior.
        const device = await devicesRepo.findByUid(guid);
        return { gateway: connectsItself(device) ? device : null, unit: null };
    }

    // First message ever from this unit over MQTT. The 30 day cleanup revokes units that were issued
    // credentials and never got this far, so stamp it once; later messages skip the write.
    if (unit.mqtt_seen_epoch === null || unit.mqtt_seen_epoch === undefined)
    {
        await knex(T("device_credentials")).where({ id: unit.id }).whereNull("mqtt_seen_epoch").update({ mqtt_seen_epoch: nowEpoch() });
    }

    const placement = await credentials.currentPlacement(unit.mac);
    return { gateway: connectsItself(placement) ? placement : null, unit: unit };
}

// An unclaimed unit's status still carries its firmware, and the registry is the only place a unit
// with no placement is visible (the future unassociated devices page reads last_firmware from it).
// A retained replay is skipped: it would stamp the registry as heard now.
async function touchUnclaimed(unit, channel, payload, receipt, retained)
{
    if (channel !== "status" || retained) { return; }
    let status = null;
    try { status = JSON.parse(payload.toString("utf8")); }
    catch (err) { return; }
    const fw = firmwareOf(status);
    await registry.touch(unit.mac, { epoch: receipt, firmware: fw, via: "frame", deviceUid: null });
}

// Firmware may send "firmware" or "fw" (gateway-protocol 4.4). Either is accepted.
function firmwareOf(status)
{
    if (!status) { return null; }
    const fw = status.firmware !== undefined && status.firmware !== null ? status.firmware : status.fw;
    return fw === undefined || fw === null || fw === "" ? null : String(fw);
}

async function rawLog(topic, payload)
{
    if (settings.get("RAW_PUBLISH_LOG_DAYS", 0) > 0)
    {
        await knex(T("raw_publish_log")).insert({ epoch: nowEpoch(), topic: topic, payload: payload }).catch(() => {});
    }
}

// meta.retained: the broker sent a stored retained copy because we subscribed (mqtt/client.js).
async function handle(topic, payload, meta)
{
    const retained = !!(meta && meta.retained);
    await rawLog(topic, payload);
    const t = topics.parse(topic);
    if (!t) { return; }

    const receipt = nowEpoch();
    const { gateway, unit } = await resolve(t.guid);

    // Config belongs to the unit (MAC), so it is kept even while the unit has no placement.
    if (t.channel === "config")
    {
        const mac = unit ? unit.mac : (gateway ? gateway.hardware_id : null);
        return handleConfig(mac, gateway, t.key, payload, receipt);
    }

    if (!gateway)
    {
        if (unit)
        {
            // A controller with no placement pressing its pairing button still gets its answer (a
            // refusal), or it would wait for its own timeout.
            if (t.channel === "event") { await unplacedPairRequest(unit, t.guid, payload); }
            // Unclaimed, or its placement was removed: expected, so debug rather than warn. Adding
            // its MAC to a location starts delivery with no action on the device.
            await touchUnclaimed(unit, t.channel, payload, receipt, retained);
            logger.debug({ topic: topic, mac: unit.mac }, "publish from an unclaimed unit; nothing to deliver to");
            return;
        }
        logger.warn({ topic: topic }, "publish from unknown device guid");
        return;
    }
    if (t.channel === "status") { return handleStatus(gateway, payload, receipt, retained, t.guid); }
    if (t.channel === "data") { return handleData(gateway, payload, receipt); }
    if (t.channel === "geoscan") { return handleGeoscan(gateway, payload); }
    if (t.channel === "cmd_ack") { return handleCmdAck(gateway, payload); }
    if (t.channel === "event") { return handleEvent(gateway, payload, receipt, t.guid); }
    if (t.channel === "frame") { return handleFrame(gateway, payload, receipt); }
}

// dev/{guid}/status: connectivity, retained. Types that follow gateway-protocol 4.4 (statusMap) still
// get their own sensors from it; others send readings on dev/{guid}/data instead (dataMap).
// A retained replay only refreshes firmware: last seen and readings come from live messages only,
// or every reconnect of the ingest client would mark the whole fleet as heard now.
async function handleStatus(gateway, payload, receipt, retained, guid)
{
    let status;
    try { status = JSON.parse(payload.toString("utf8")); }
    catch (err) { logger.warn({ gateway: gateway.uid }, "status payload is not JSON"); return; }
    const fw = firmwareOf(status);
    // Offline (last will, or the pod's own publish before a clean disconnect): a controller's pairing
    // ends (services/stations.wentOffline), also for a retained replay, which is the current state.
    // Nothing else: an offline message must not stamp the unit as heard now.
    if (status && status.online === false)
    {
        await require("../services/stations").wentOffline(gateway, await typeForDevice(gateway));
        return;
    }
    if (retained)
    {
        if (fw) { await knex(T("devices")).where({ id: gateway.id }).update({ firmware: fw.slice(0, 24) }); }
        return;
    }
    const type = await typeForDevice(gateway);
    if (!type) { return; }

    const values = mapFields(type.statusMap, status);
    // is_offline is never written here: it is set by a person (device Settings) and by scheduled
    // offline periods (jobs/tasks/offlinePeriods.js), and a device that comes and goes while being
    // worked on stays offline for the whole period.
    const patch = { last_seen_epoch: receipt };
    if (fw) { patch.firmware = fw.slice(0, 24); }
    await knex(T("devices")).where({ id: gateway.id }).update(patch);
    if (gateway.hardware_id && require("../services/devices").isMac(gateway.hardware_id)) { await registry.touch(gateway.hardware_id, { epoch: receipt, firmware: fw, via: "frame", deviceUid: gateway.uid }); }
    await pipeline.ingest({ device: gateway, type: type, epoch: receipt, values: values, gatewayId: gateway.id });

    // A live connect: config writes the unit has not confirmed go out again (services/unitConfig).
    if (status.event === "connect" && gateway.hardware_id && require("../services/devices").isMac(gateway.hardware_id))
    {
        await require("../services/unitConfig").resendPending(gateway.hardware_id, guid);
        // Queued commands: the unacked one again (same id), else the next (services/commandQueue.js).
        await require("../services/commandQueue").onConnect(gateway, guid);
    }
}

// { payload field: channel id } -> { channel: value }; absent fields skip, extra fields are ignored.
function mapFields(map, obj)
{
    const values = {};
    for (const [field, channel] of Object.entries(map || {}))
    {
        if (obj[field] !== undefined && obj[field] !== null) { values[channel] = obj[field]; }
    }
    return values;
}

// dev/{guid}/data: the device's own readings, not retained, mapped by the type's dataMap.
async function handleData(gateway, payload, receipt)
{
    let data;
    try { data = JSON.parse(payload.toString("utf8")); }
    catch (err) { logger.warn({ gateway: gateway.uid }, "data payload is not JSON"); return; }
    if (!data || typeof data !== "object") { logger.warn({ gateway: gateway.uid }, "data payload is not an object"); return; }
    const type = await typeForDevice(gateway);
    if (!type) { return; }

    await knex(T("devices")).where({ id: gateway.id }).where(function () { this.whereNull("last_seen_epoch").orWhere("last_seen_epoch", "<", receipt); }).update({ last_seen_epoch: receipt });
    await pipeline.ingest({ device: gateway, type: type, epoch: receipt, values: mapFields(type.dataMap, data), gatewayId: gateway.id });
}

// dev/{guid}/config/{key}: one config value per publish, bare value. Sent on every connect and as
// the reply to a write, which it confirms (services/unitConfig). The type comes from the placement
// when there is one, else from the type the unit declared when it provisioned.
async function handleConfig(mac, gateway, key, payload, receipt)
{
    if (!mac || !require("../services/devices").isMac(mac)) { logger.debug({ key: key }, "config from a unit with no MAC; ignored"); return; }
    let type = gateway ? await typeForDevice(gateway) : null;
    if (!type)
    {
        const cred = await credentials.forMac(mac);
        try { type = cred && cred.type_slug ? deviceTypes.get(cred.type_slug) : null; }
        catch (err) { type = null; }
    }
    await require("../services/unitConfig").report(mac, key, payload.toString("utf8"), type, receipt);
}

// dev/{guid}/cmd_ack: the ack of a queued command, JSON { id, ok, results?, error? }
// (services/commandQueue.js, pod-protocol.md 5.2). An ack without an id, from a unit whose commands
// are not queued (JSON { event, value, response|result }), is only logged. A geoscan command has no
// ack: the geoscan publish itself is the reply.
async function handleCmdAck(gateway, payload)
{
    if (await require("../services/commandQueue").onAck(gateway, payload)) { return; }
    logger.info({ gateway: gateway.uid, ack: payload.toString("utf8").slice(0, 200) }, "gateway cmd_ack");
}

// dev/{guid}/event: pod events (pod-protocol.md section 8). A wristband ("band") presented to a
// controller checks its athlete in at that station, and to an account pod shows it for enrollment
// (services/athletes.js); the pod's open pages are told through its config notice. Anything else
// (game events later) is recorded in the event log for now.
async function handleEvent(gateway, payload, receipt, guid)
{
    const text = payload.toString("utf8").slice(0, 1000);
    let kind = null;
    let e = null;
    try { e = JSON.parse(text); kind = e && typeof e.event === "string" ? e.event.slice(0, 30) : null; }
    catch (err) { }
    if (kind === "band")
    {
        const type = await typeForDevice(gateway);
        const athletes = require("../services/athletes");
        const band = athletes.normalizeBand(e.band);
        if (type && (type.station || type.enrolls) && band)
        {
            const r = await athletes.present(gateway, band, Number(e.rssi), receipt);
            logger.info({ pod: gateway.uid, band: band, outcome: r.outcome }, "wristband presented");
            await require("../services/unitConfig").notifyMac(gateway.hardware_id);
            return;
        }
    }
    if (kind === "pair_request")
    {
        // A controller's function button (services/stations.buttonRequest, pod-protocol.md 6.3).
        const type = await typeForDevice(gateway);
        if (type && type.station) { await require("../services/stations").buttonRequest(gateway, gateway.hardware_id, guid, type); return; }
    }
    if (kind === "ota_progress")
    {
        // A firmware update in progress (pod-protocol.md 5.4 ota), shown on the pages; not logged.
        if (!(await require("../services/commandQueue").onProgress(gateway, e))) { logger.info({ pod: gateway.uid, mac: e.mac, pct: e.pct }, "ota progress with no ota in flight"); }
        return;
    }
    const activity = require("../services/activity");
    await activity.record("pod_event", { entity_type: "device", entity_uid: gateway.uid, detail: (kind ? kind + ": " : "") + text }, { channel: "mqtt", correlationId: activity.newCorrelationId() });
}

// A pair_request from a unit with no placement: refused (services/stations.buttonRequest).
async function unplacedPairRequest(unit, guid, payload)
{
    let e = null;
    try { e = JSON.parse(payload.toString("utf8")); }
    catch (err) { return; }
    if (!e || e.event !== "pair_request" || !unit.type_slug) { return; }
    let type = null;
    try { type = deviceTypes.get(unit.type_slug); }
    catch (err) { return; }
    if (type.station) { await require("../services/stations").buttonRequest(null, unit.mac, guid, type); }
}

// dev/{guid}/geoscan: wifi and cell scan for location. Accepted and logged only; the location
// lookup is not built yet.
async function handleGeoscan(gateway, payload)
{
    logger.debug({ gateway: gateway.uid, bytes: payload.length }, "gateway geoscan");
}

// dev/{guid}/frame: one relayed LoRa frame (gateway-protocol 4.1).
// Two frame shapes on dev/{guid}/frame:
//   JSON (pod stations, DECISIONS.md "Pod stations"): { mac, rssi, model, fw, boot, seq, data: { key: value } }.
//     The relaying controller sets mac from its ESP-NOW receive callback, so a pod cannot claim
//     another's MAC; data keys map through the pod type's dataMap. The dedup counter is
//     boot * 2^32 + seq: seq restarts on reboot, and device_frames keeps counters for
//     DEVICE_FRAMES_HOURS, so a counter from seq alone would drop a rebooted pod's frames as
//     duplicates. boot is the pod's boot count from NVS; without it seq alone is used.
//   Binary (LoRa, architecture 4.2): { frame: base64 packed struct, rssi, seconds_ago }, parsed by
//     frames.parseHeader and the node type's field list. Kept, unused by the pods.
function jsonFrameHeader(env)
{
    const mac = String(env.mac || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (mac.length !== 12) { return null; }
    const seq = Number(env.seq);
    const boot = Number(env.boot);
    let counter = null;
    if (Number.isInteger(seq) && seq >= 0 && seq < 4294967296)
    {
        // Stays an exact integer while boot < 2^21 (about two million reboots).
        counter = Number.isInteger(boot) && boot >= 0 && boot < 2097152 ? boot * 4294967296 + seq : seq;
    }
    return {
        mac: mac,
        model: env.model ? String(env.model).slice(0, 40) : null,
        firmware: env.fw ? String(env.fw).slice(0, 24) : null,
        counter: counter,
        json: true
    };
}

async function handleFrame(gateway, payload, receipt)
{
    let env;
    try { env = JSON.parse(payload.toString("utf8")); }
    catch (err) { logger.warn({ gateway: gateway.uid }, "frame payload is not JSON"); return; }
    if (!env || typeof env !== "object") { logger.warn({ gateway: gateway.uid }, "frame payload is not an object"); return; }
    const isJson = env.data !== null && typeof env.data === "object" && !Array.isArray(env.data);
    let header;
    if (isJson)
    {
        header = jsonFrameHeader(env);
        if (!header) { logger.warn({ gateway: gateway.uid }, "JSON frame without a 12 hex digit mac"); return; }
    }
    else
    {
        const raw = Buffer.from(env.frame || "", "base64");
        header = frames.parseHeader(raw);
        if (!header) { logger.warn({ gateway: gateway.uid, bytes: raw.length }, "frame too short"); return; }
    }

    const observed = receipt - (Number(env.seconds_ago) || 0);
    const rssi = env.rssi === undefined ? null : Number(env.rssi);
    await knex(T("devices")).where({ id: gateway.id }).where(function () { this.whereNull("last_seen_epoch").orWhere("last_seen_epoch", "<", receipt); }).update({ last_seen_epoch: receipt });

    let device = await devicesRepo.findLiveByHardwareId(header.mac);
    // Pod stations: a target pod's frame through a controller in pairing mode places it there, or
    // moves it there from another controller (services/stations.js).
    const paired = await require("../services/stations").placeFromFrame(gateway, device, header);
    if (paired) { device = paired; }
    await registry.touch(header.mac, { epoch: observed, model: header.model, firmware: header.firmware, via: "frame", deviceUid: device ? device.uid : null });
    if (!device)
    {
        await registry.heardBy(header.mac, gateway.id, observed, rssi);
        logger.info({ mac: header.mac, model: header.model, gateway: gateway.uid }, "frame from unknown device (registry updated)");
        return;
    }
    const type = await typeForDevice(device);
    if (!type) { return; }

    // Coverage and the gateway's RSSI reading happen for winners and losers alike (architecture 3.6).
    await readingsRepo.upsertCoverage(device.id, gateway.id, observed, rssi);
    await pipeline.ingest({ device: device, type: type, epoch: observed, values: deviceTypes.gatewayValues(type, gateway.hardware_id, { rssi: rssi }), gatewayId: gateway.id, rssi: rssi, canonical: true });

    let won = true;
    if (type.dedupMode === "counter" && header.counter !== null && header.counter !== undefined) { won = await readingsRepo.claimFrame(device.id, header.counter, observed); }
    else if (type.dedupMode === "window")
    {
        const bucket = Math.floor(observed / Math.max(type.minIntervalSecs || 60, 1));
        won = await readingsRepo.claimFrame(device.id, bucket, observed);
    }
    if (!won) { return; }

    const values = isJson ? mapFields(type.dataMap, env.data) : frames.parseFields(type.fields || [], header);
    delete values.rssi;
    if (header.firmware && header.firmware !== device.firmware)
    {
        await knex(T("devices")).where({ id: device.id }).update({ firmware: header.firmware, model: header.model || device.model });
    }
    await pipeline.ingest({ device: device, type: type, epoch: observed, values: values, gatewayId: gateway.id, rssi: rssi });
}

// jsonFrameHeader: exported for tests/pods.test.js.
module.exports = { handle, typeForDevice, jsonFrameHeader };
