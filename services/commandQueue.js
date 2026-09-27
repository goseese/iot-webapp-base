// Queued commands (DECISIONS.md "Queued commands", pod-protocol.md section 5, migration 0005).
//
// Every command to a pod type (commandQueue: true) waits in command_queue until the pod acks it:
// queued -> sent -> done | failed. A target pod's commands go to the controller it is paired with,
// addressed to its MAC ("to"), and share that controller's queue.
//
//   - One command in flight per pod: pump() publishes the oldest queued command only when none is
//     sent and unacked. It runs after a command is added or cancelled (web process) and after an ack
//     or a connect (ingest process), under a per pod advisory lock so the two processes never send
//     two at once.
//   - A sent command is published again, same cmd_id, when the pod publishes its connect message
//     (onConnect). The pod carries out an id once and acks repeats (pod-protocol.md 5.3).
//   - Cancel deletes the row. A pod that already has the command may still carry it out; its late
//     ack finds no row and is only logged.
//   - A target pod's set_config (its Config tab) also marks the key pending in unit_config for the
//     target's MAC; the ack confirms it there, or clears it on failure.
const logger = require("../config/logger");
const { knex, T, nowEpoch } = require("../db/knex");
const credentials = require("../db/repos/credentials");
const devicesRepo = require("../db/repos/devices");
const topics = require("../mqtt/topics");
const downlink = require("../mqtt/downlink");

const LOCK_CLASS = 7305;        // pg_advisory_xact_lock(class, device id): one sender per pod
const PENDING = ["queued", "sent"];
// Commands whose value is stored as JSON text and sent as an object: set_config { key, value },
// ota { url, md5 } (pod-protocol.md 5.4).
const JSON_VALUES = ["set_config", "ota"];

// Where a placement's commands go. { pod, guid, target, targetDeviceId } or { error } for the page.
//   unit hardware (a controller or account pod): published to itself, no target
//   a target pod: published to its controller, target = its MAC
async function route(device)
{
    let pod = device;
    let target = null;
    let targetDeviceId = null;
    if (!credentials.isUnitHardware(device))
    {
        pod = device.controller_id ? await devicesRepo.findById(device.controller_id) : null;
        if (!pod || pod.delete_epoch) { return { error: "This pod is not paired with a controller, so it cannot be sent commands." }; }
        target = device.hardware_id;
        targetDeviceId = device.id;
    }
    const cred = await credentials.forDevice(pod);
    if (!cred || cred.state !== "active")
    {
        return { error: target ? "Its controller, " + pod.name + ", has no active broker credentials yet, so commands cannot be sent." : "This pod has no active broker credentials yet, so it cannot be sent commands.", pod: pod };
    }
    return { pod: pod, guid: cred.broker_username, target: target, targetDeviceId: targetDeviceId };
}

// Tell open pages of the pod (and of its target pods, which listen for the controller) that its
// queue changed: the config notice the Config tab already uses.
async function notify(pod)
{
    if (pod && pod.hardware_id) { await require("./unitConfig").notifyMac(pod.hardware_id); }
}

function message(row)
{
    const m = { id: row.cmd_id, cmd: row.cmd };
    if (row.target) { m.to = row.target; }
    if (row.value !== null && row.value !== undefined)
    {
        m.value = JSON_VALUES.includes(row.cmd) ? JSON.parse(row.value) : row.value;
    }
    return JSON.stringify(m);
}

// Runs fn(trx) holding the pod's lock.
function locked(deviceId, fn)
{
    return knex.transaction(async (trx) =>
    {
        await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [LOCK_CLASS, deviceId]);
        return fn(trx);
    });
}

async function publishRow(trx, row, guid)
{
    const ok = await downlink.publish(topics.device.queued(guid), message(row));
    if (ok) { await trx(T("command_queue")).where({ id: row.id }).update({ status: "sent", sent_epoch: nowEpoch(), sent_count: row.sent_count + 1 }); }
    return ok;
}

// Sends the pod's next queued command if nothing is in flight. Never throws.
async function pump(deviceId)
{
    try
    {
        const pod = await devicesRepo.findById(deviceId);
        const cred = pod ? await credentials.forDevice(pod) : null;
        if (!cred || cred.state !== "active") { return false; }
        const sent = await locked(deviceId, async (trx) =>
        {
            if (await trx(T("command_queue")).where({ device_id: deviceId, status: "sent" }).first()) { return false; }
            const next = await trx(T("command_queue")).where({ device_id: deviceId, status: "queued" }).orderBy("id").first();
            return next ? publishRow(trx, next, cred.broker_username) : false;
        });
        if (sent) { await notify(pod); }
        return sent;
    }
    catch (err)
    {
        logger.error({ err: err.message, deviceId: deviceId }, "command queue: send failed");
        return false;
    }
}

// From a page. Returns the new row; it goes out now if the pod has nothing in flight.
async function enqueue(input)
{
    const ids = await knex(T("command_queue")).insert(
    {
        device_id: input.pod.id, target: input.target || null, target_device_id: input.targetDeviceId || null,
        cmd: input.cmd, value: input.value === undefined || input.value === null ? null : String(input.value),
        status: "queued", created_epoch: nowEpoch(), created_by: input.userId || null
    }).returning("id");
    const id = require("../db/knex").insertId(ids);
    await pump(input.pod.id);
    await notify(input.pod);
    return knex(T("command_queue")).where({ id: id }).first();
}

// From ingest, on a live connect message: the unacked command goes out again, same id; otherwise
// the next queued one.
async function onConnect(pod, guid)
{
    try
    {
        const resent = await locked(pod.id, async (trx) =>
        {
            const inFlight = await trx(T("command_queue")).where({ device_id: pod.id, status: "sent" }).orderBy("id");
            for (const row of inFlight) { await publishRow(trx, row, guid); }
            return inFlight.length;
        });
        if (resent > 0) { logger.info({ device: pod.uid, count: resent }, "command queue: unacked command sent again on connect"); }
        else { await pump(pod.id); }
    }
    catch (err) { logger.error({ err: err.message, device: pod.uid }, "command queue: connect handling failed"); }
}

// From ingest, dev/{guid}/cmd_ack. Returns false when the payload is not a queued command's ack
// (no id), so the caller can log it as before.
async function onAck(pod, payload)
{
    let ack;
    try { ack = JSON.parse(payload.toString("utf8")); }
    catch (err) { return false; }
    if (!ack || typeof ack !== "object" || typeof ack.id !== "string") { return false; }
    const cmdId = ack.id.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cmdId))
    {
        logger.warn({ device: pod.uid, id: ack.id }, "command queue: ack with an id that is not ours");
        return true;
    }
    const row = await knex(T("command_queue")).where({ cmd_id: cmdId, device_id: pod.id }).first();
    if (!row)
    {
        logger.info({ device: pod.uid, id: cmdId }, "command queue: ack for a cancelled or unknown command");
        await pump(pod.id);
        return true;
    }
    if (row.status === "done" || row.status === "failed")
    {
        await pump(pod.id);
        return true;
    }
    const ok = ack.ok === true;
    const result = { ok: ok };
    if (ack.results && typeof ack.results === "object" && !Array.isArray(ack.results))
    {
        result.results = {};
        for (const [mac, r] of Object.entries(ack.results).slice(0, 32)) { result.results[String(mac).replace(/[^0-9a-fA-F]/g, "").toUpperCase()] = String(r).slice(0, 40); }
    }
    if (ack.error !== undefined && ack.error !== null) { result.error = String(ack.error).slice(0, 300); }
    const now = nowEpoch();
    await knex(T("command_queue")).where({ id: row.id }).update({ status: ok ? "done" : "failed", done_epoch: now, result: JSON.stringify(result) });
    logger.info({ device: pod.uid, cmd: row.cmd, target: row.target, ok: ok }, "command queue: acked");

    if (row.cmd === "set_config" && row.target && row.target !== "all") { await settleConfig(row, result, now); }
    await notify(pod);
    await pump(pod.id);
    return true;
}

// From ingest, {"event":"ota_progress","mac":..,"pct":N} on dev/{guid}/event: kept on the pod's ota
// command in flight, per MAC, for the pages. The pod's own update may leave out mac. Returns false
// when there is no ota in flight (a cancelled one, say); the caller only logs it.
async function onProgress(pod, e)
{
    const mac = String(e.mac || pod.hardware_id || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    const pct = Math.max(0, Math.min(100, Math.round(Number(e.pct))));
    if (mac.length !== 12 || !Number.isFinite(pct)) { return false; }
    const row = await knex(T("command_queue")).where({ device_id: pod.id, cmd: "ota", status: "sent" }).orderBy("id").first();
    if (!row) { return false; }
    await knex(T("command_queue")).where({ id: row.id }).update({ progress: knex.raw("COALESCE(progress, '{}'::jsonb) || jsonb_build_object(?::text, ?::int)", [mac, pct]) });
    await notify(pod);
    return true;
}

// A target pod's set_config ack confirms (or clears) the pending value on its Config tab.
async function settleConfig(row, result, now)
{
    let v;
    try { v = JSON.parse(row.value); }
    catch (err) { return; }
    const unitConfig = require("./unitConfig");
    const perTarget = result.results ? result.results[row.target] : (result.ok ? "ok" : "error");
    if (perTarget === "ok")
    {
        const target = row.target_device_id ? await devicesRepo.findById(row.target_device_id) : null;
        const type = target ? await require("./stations").typeOf(target) : null;
        await unitConfig.report(row.target, v.key, String(v.value), type, now);
    }
    else
    {
        await unitConfig.cancel(row.target, v.key);
    }
}

// From a page: removes a queued or sent command. Returns the row removed, or null.
async function cancel(row)
{
    const n = await knex(T("command_queue")).where({ id: row.id }).whereIn("status", PENDING).del();
    if (n === 0) { return null; }
    if (row.cmd === "set_config" && row.target && row.target !== "all")
    {
        try { await require("./unitConfig").cancel(row.target, JSON.parse(row.value).key); }
        catch (err) { }
    }
    const pod = await devicesRepo.findById(row.device_id);
    await pump(row.device_id);
    await notify(pod);
    return row;
}

// A target pod's Config tab cancel: its pending set_config commands for that key go too.
async function cancelConfig(targetMac, key)
{
    const rows = await knex(T("command_queue")).where({ target: targetMac, cmd: "set_config" }).whereIn("status", PENDING);
    for (const r of rows)
    {
        let k = null;
        try { k = JSON.parse(r.value).key; }
        catch (err) { }
        if (k === key) { await cancel(r); }
    }
}

// Page lists: a pod's own queue (its target pods' commands included), or one target pod's commands.
// Pending first, then the most recent finished ones.
function list(where, limit)
{
    return knex(T("command_queue") + " as q")
        .leftJoin(T("devices") + " as t", "t.id", "q.target_device_id")
        .leftJoin(T("users") + " as u", "u.id", "q.created_by")
        .where(where)
        .select("q.*", "t.name as target_name", "t.uid as target_uid", "u.username")
        .orderByRaw("CASE WHEN q.status IN ('queued', 'sent') THEN 0 ELSE 1 END, q.id DESC")
        .limit(limit || 50);
}

function forPod(podId) { return list({ "q.device_id": podId }); }
// A controller's ota commands still to be answered, for its Station tab.
function pendingOta(podId) { return knex(T("command_queue")).where({ device_id: podId, cmd: "ota" }).whereIn("status", PENDING).orderBy("id"); }
function forTarget(targetDeviceId) { return list({ "q.target_device_id": targetDeviceId }); }

module.exports = { route, enqueue, pump, onConnect, onAck, onProgress, cancel, cancelConfig, forPod, forTarget, pendingOta, message };
