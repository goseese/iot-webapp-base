// Gateway configuration (migration 0021): what each unit reports on dev/{guid}/config/{key}, and
// writes from the config page waiting for the unit to confirm them.
//
// A write publishes dev/{guid}/cmd/set_config/{key} (not retained) and records desired_value. The
// firmware applies it, saves it and publishes config/{key} with the value it now holds; when that
// matches the desired value the write is confirmed and desired_value clears. Until then the page
// shows the key as pending. A unit that was offline gets every pending key again when it connects
// (resendPending, from ingest). The gateway echoes the value as it stores it, not as it was sent,
// so both sides are compared after normalize(): e.g. "21, 22" and "21,22" for a hex list, "915"
// and "915.0" for a float, "yes" and "true" for a bool.
const { knex, T, nowEpoch } = require("../db/knex");
const logger = require("../config/logger");
const topics = require("../mqtt/topics");
const downlink = require("../mqtt/downlink");

// Tell open config pages that this unit's rows changed: acct/{account}/config, relayed to the
// account's socket.io room (realtime/index.js). Device uid only, no values. A unit with no
// placement has no page and no account, so nothing is sent. Never throws.
async function notify(mac)
{
    try
    {
        const placement = await require("../db/repos/credentials").currentPlacement(mac);
        if (!placement) { return; }
        const accountUid = await require("../pipeline/publish").accountUidForLocation(placement.location_id);
        if (!accountUid) { return; }
        await downlink.publish(topics.account.config(accountUid), JSON.stringify({ event: "config", device: String(placement.uid).toLowerCase() }));
    }
    catch (err) { logger.warn({ err: err.message, mac: mac }, "config notice failed"); }
}

const { normalize, validate } = require("./configValues");

async function upsert(mac, key, patch)
{
    const n = await knex(T("unit_config")).where({ mac: mac, config_key: key }).update(patch);
    if (n > 0) { return; }
    try { await knex(T("unit_config")).insert(Object.assign({ mac: mac, config_key: key }, patch)); }
    catch (err) { await knex(T("unit_config")).where({ mac: mac, config_key: key }).update(patch); }   // lost the insert race
}

// From ingest: the unit published config/{key}. Confirms a pending write when the values match.
async function report(mac, key, value, typeModule, epoch)
{
    const def = typeModule && typeModule.configKeys ? typeModule.configKeys[key] : null;
    const text = String(value).slice(0, 255);
    await upsert(mac, key, { reported_value: text, reported_epoch: epoch });
    const row = await knex(T("unit_config")).where({ mac: mac, config_key: key }).first();
    if (row && row.desired_value !== null && normalize(def, row.desired_value) === normalize(def, text))
    {
        await knex(T("unit_config")).where({ id: row.id }).update({ desired_value: null, desired_epoch: null, desired_by: null, sent_epoch: null });
        logger.info({ mac: mac, key: key, value: text }, "config write confirmed by unit");
    }
    await notify(mac);
}

// From the config page. Returns { ok, sent, error? }. sent false means no broker connection right
// now; the write stays pending and goes out when the unit next connects.
async function write(mac, guid, key, raw, typeModule, userId)
{
    const def = typeModule && typeModule.configKeys ? typeModule.configKeys[key] : null;
    if (!def || !def.writable) { return { ok: false, error: "That setting cannot be changed." }; }
    const v = validate(def, raw);
    if (!v.ok) { return v; }
    const now = nowEpoch();
    await upsert(mac, key, { desired_value: v.value, desired_epoch: now, desired_by: userId || null, sent_epoch: null });
    const sent = await downlink.publish(topics.device.setConfig(guid, key), v.value);
    if (sent) { await knex(T("unit_config")).where({ mac: mac, config_key: key }).update({ sent_epoch: now }); }
    await notify(mac);
    return { ok: true, sent: sent };
}

async function cancel(mac, key)
{
    await knex(T("unit_config")).where({ mac: mac, config_key: key }).update({ desired_value: null, desired_epoch: null, desired_by: null, sent_epoch: null });
    await notify(mac);
}

// From ingest, on a live connect message: every write the unit has not confirmed goes out again.
async function resendPending(mac, guid)
{
    const rows = await knex(T("unit_config")).where({ mac: mac }).whereNotNull("desired_value");
    for (const r of rows)
    {
        if (await downlink.publish(topics.device.setConfig(guid, r.config_key), r.desired_value))
        {
            await knex(T("unit_config")).where({ id: r.id }).update({ sent_epoch: nowEpoch() });
        }
    }
    if (rows.length > 0) { logger.info({ mac: mac, keys: rows.map((r) => r.config_key) }, "pending config re-sent on connect"); }
}

// Page model: declared keys in declaration order, then anything else the unit reported.
async function forPage(mac, typeModule)
{
    const rows = mac ? await knex(T("unit_config")).where({ mac: mac }) : [];
    const byKey = new Map(rows.map((r) => [r.config_key, r]));
    const defs = (typeModule && typeModule.configKeys) || {};
    const out = Object.entries(defs).map(([key, def]) => Object.assign({ key: key, def: def }, byKey.get(key) || {}));
    for (const r of rows) { if (!defs[r.config_key]) { out.push(Object.assign({ key: r.config_key, def: { label: r.config_key, kind: "string", writable: false } }, r)); } }
    return out;
}

// notifyMac: the same notice, for other changes shown on a unit's pages (a pod station's roster).
module.exports = { normalize, validate, report, write, cancel, resendPending, forPage, notifyMac: notify };
