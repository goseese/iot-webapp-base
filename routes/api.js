// HTTP API v1 (architecture 10). Mounted before session and CSRF: bearer only, JSON only.
// Reads return canonical values plus display values; writes enter the pipeline at stage 2.
const express = require("express");
const { knex, T, nowEpoch } = require("../db/knex");
const settings = require("../config/settings");
const permissions = require("../permissions");
const apiAuth = require("../services/apiAuth");
const metrics = require("../metrics");
const display = require("../services/display");
const deviceTypes = require("../deviceTypes");
const pipeline = require("../pipeline");
const actions = require("../services/alarms/actions");
const alarmsRepo = require("../db/repos/alarms");
const activity = require("../services/activity");
const logger = require("../config/logger");
const alarmTitle = require("../services/alarms/title");
const ruleHistory = require("../services/alarms/ruleHistory");
const { isUuid } = require("../middleware/account");
const { worse, pageByEpoch, limitOf, parseJson, typedValue, missingScope, minutesOf, flagOf } = require("../services/apiHelpers");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../middleware/account").uidParam);
router.use(express.json({ limit: "2mb" }));
router.use((req, res, next) => apiAuth.authenticate(req, res, next).catch(next));

const uidOf = (u) => String(u).toLowerCase();

router.get("/locations", async (req, res, next) =>
{
    try
    {
        const locs = await apiAuth.visibleLocations(req);
        res.json({ locations: locs.map((l) => ({ uid: uidOf(l.uid), name: l.name, timezone: l.iana_timezone, membership_mode: l.membership_mode })) });
    }
    catch (err) { next(err); }
});

async function locationsMap(req)
{
    const locs = await apiAuth.visibleLocations(req);
    return new Map(locs.map((l) => [l.id, l]));
}

const num = (v) => (v === null || v === undefined) ? null : Number(v);

// A canonical value as text: converted to unit, unit appended. precision is the sensor's own
// display_precision when given (as display.format and the alarm title use it), else the metric's
// (as the sensor page's rule thresholds and their change history use it).
function shownIn(metric, unit, precision)
{
    const p = precision !== null && precision !== undefined ? precision : metrics.precision(metric, unit);
    return (v) => (v === null || v === undefined) ? null : metrics.fromCanonical(metric, Number(v), unit).toFixed(p) + (unit ? " " + unit : "");
}

// The alarm title (services/alarms/title.js), the same text as the email subject after the event word.
// Never built here. A title that cannot be resolved is null, so one bad template does not fail the request.
async function titleOf(ctx, rule)
{
    try
    {
        return await alarmTitle.forAlarm(ctx, rule || null);
    }
    catch (err)
    {
        logger.warn({ alarm: ctx.id, err: err.message }, "api alarm title failed, name is null");
        return null;
    }
}

// Alarm names for list rows. rows carry a.* plus sensor_name, metric, display_unit, display_precision,
// sensor_alarm_title, device_name, device_alarm_title and location_id; locs is locationsMap(). Rules
// (deleted ones included) and account names are read once for the page. Returns Map(alarm id -> name).
async function alarmNames(rows, locs)
{
    const out = new Map();
    if (!rows.length) { return out; }
    const ruleIds = Array.from(new Set(rows.map((a) => a.rule_id).filter((id) => id !== null && id !== undefined)));
    const rules = new Map((ruleIds.length ? await knex(T("alarm_rules")).whereIn("id", ruleIds) : []).map((r) => [r.id, r]));
    const accountIds = Array.from(new Set(rows.map((a) => locs.get(a.location_id).account_id)));
    const accounts = new Map((await knex(T("accounts")).whereIn("id", accountIds).select("id", "name")).map((x) => [x.id, x.name]));
    for (const a of rows)
    {
        const loc = locs.get(a.location_id);
        const ctx = Object.assign({}, a, { location_name: loc.name, account_id: loc.account_id, account_name: accounts.get(loc.account_id) });
        out.set(a.id, await titleOf(ctx, rules.get(a.rule_id)));
    }
    return out;
}

// Columns every alarm list query selects, so alarmNames() has what the title needs.
const ALARM_LIST_COLUMNS = ["a.*", "s.uid as sensor_uid", "s.name as sensor_name", "s.metric", "s.display_unit", "s.display_precision", "s.alarm_title as sensor_alarm_title",
    "d.uid as device_uid", "d.name as device_name", "d.alarm_title as device_alarm_title", "d.location_id"];

// Alarm status per sensor (DECISIONS "API detail endpoints"): every active alarm, oldest first, and
// alarm_status, the worst active severity or "ok". Returns Map(sensor id -> { alarm_status, active_alarms }).
async function alarmStatus(sensorIds)
{
    const out = new Map(sensorIds.map((id) => [id, { alarm_status: "ok", active_alarms: [] }]));
    if (!sensorIds.length) { return out; }
    const rows = await knex(T("alarms")).whereIn("sensor_id", sensorIds).whereNull("cleared_epoch").orderBy([{ column: "raised_epoch", order: "asc" }, { column: "id", order: "asc" }]);
    for (const a of rows)
    {
        const st = out.get(a.sensor_id);
        st.active_alarms.push({ uid: uidOf(a.uid), severity: a.severity, direction: a.direction, raised_epoch: Number(a.raised_epoch), acknowledged: !!a.acked_epoch,
            ack_until_epoch: num(a.ack_until_epoch), suppressed: !!a.suppressed_by, trigger_value: a.trigger_value });
        st.alarm_status = worse(st.alarm_status, a.severity);
    }
    return out;
}

// One sensor as the detail endpoints return it. s carries device_uid; loc is its location row.
async function sensorOut(s, loc, status)
{
    const unit = await display.resolveUnit(s, loc);
    return Object.assign({ uid: uidOf(s.uid), device: uidOf(s.device_uid), channel: s.channel_id, name: s.name, metric: s.metric, canonical_unit: metrics.get(s.metric).canonical,
        display_unit: unit, is_hidden: !!s.is_hidden, last_value: s.last_value, last_display: await display.format(s, s.last_value, loc), last_epoch: num(s.last_epoch) }, status);
}

function locationOut(l)
{
    return { uid: uidOf(l.uid), name: l.name, timezone: l.iana_timezone, alarm_mode: l.alarm_mode };
}

// Location, device and sensor uid filters on a query joined as d (devices) and s (sensors). Returns
// false when a filter names nothing the key can see or is not a uid, so the caller answers an empty list.
function applyScopeFilters(req, q, locs)
{
    if (req.query.location !== undefined)
    {
        const want = String(req.query.location).toLowerCase();
        const l = Array.from(locs.values()).find((x) => uidOf(x.uid) === want);
        if (!l) { return false; }
        q.where("d.location_id", l.id);
    }
    if (req.query.device !== undefined) { if (!isUuid(req.query.device)) { return false; } q.where("d.uid", req.query.device); }
    if (req.query.sensor !== undefined) { if (!isUuid(req.query.sensor)) { return false; } q.where("s.uid", req.query.sensor); }
    return true;
}

// The locations an account filter names: the key's visible locations in that account (account uid).
// null when the uid is malformed or names no account the key can see, so the caller answers an empty list.
async function accountLocationIds(v, locs)
{
    if (!isUuid(String(v))) { return null; }
    const a = await knex(T("accounts")).where({ uid: String(v) }).first();
    const ids = a ? Array.from(locs.values()).filter((l) => l.account_id === a.id).map((l) => l.id) : [];
    return ids.length ? ids : null;
}

// An epoch query parameter as whole seconds, or null when absent or not a sane epoch. A fraction or
// 1e21 would otherwise reach a BIGINT column and fail in Postgres as a 500.
function epochOf(v)
{
    if (v === undefined || v === null || v === "") { return null; }
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 && n < 1e11 ? n : null;
}

// from and to for range endpoints: epoch seconds, default the 24 hours up to now.
function rangeOf(req)
{
    const t = epochOf(req.query.to);
    const to = t === null ? nowEpoch() : t;
    const f = epochOf(req.query.from);
    return { from: f === null ? to - 86400 : f, to: to };
}

router.get("/devices", async (req, res, next) =>
{
    try
    {
        const locs = await locationsMap(req);
        if (!locs.size) { return res.json({ devices: [] }); }
        const q = knex(T("devices") + " as d").join(T("device_types") + " as t", "t.id", "d.device_type_id").whereIn("d.location_id", Array.from(locs.keys())).whereNull("d.delete_epoch").where("d.is_archived", 0).select("d.*", "t.slug as type");
        if (req.query.location) { const l = Array.from(locs.values()).find((x) => uidOf(x.uid) === String(req.query.location).toLowerCase()); if (!l) { return res.json({ devices: [] }); } q.where("d.location_id", l.id); }
        const rows = await q;
        res.json({ devices: rows.map((d) => ({ uid: uidOf(d.uid), name: d.name, type: d.type, kind: d.kind, hardware_id: d.hardware_id, location: uidOf(locs.get(d.location_id).uid), last_seen_epoch: d.last_seen_epoch === null ? null : Number(d.last_seen_epoch), is_offline: !!d.is_offline })) });
    }
    catch (err) { next(err); }
});

// Devices that have not reported for at least minutes (DECISIONS "API silent devices"), in one account or
// location: live, not archived and not set offline by hand. Devices that never reported are included
// unless include_never_seen is no. Longest silent first, never seen ahead of all. Registered before
// /devices/:uid so "silent" is not read as a uid.
router.get("/devices/silent", async (req, res, next) =>
{
    try
    {
        const scopeErr = missingScope(req.query, ["account", "location"]);
        if (scopeErr) { return res.status(400).json({ error: scopeErr }); }
        const minutes = minutesOf(req.query.minutes);
        if (minutes === null) { return res.status(400).json({ error: "minutes is required: a whole number of minutes, at least 1." }); }
        const includeNever = flagOf(req.query.include_never_seen, true);
        const now = nowEpoch();
        const cutoff = now - minutes * 60;
        const none = () => res.json({ minutes: minutes, cutoff_epoch: cutoff, devices: [] });
        const locs = await locationsMap(req);
        if (!locs.size) { return none(); }
        const q = knex(T("devices") + " as d").join(T("device_types") + " as t", "t.id", "d.device_type_id").whereIn("d.location_id", Array.from(locs.keys()))
            .whereNull("d.delete_epoch").where("d.is_archived", false).where("d.is_offline", false)
            .where(function () { this.where("d.last_seen_epoch", "<=", cutoff); if (includeNever) { this.orWhereNull("d.last_seen_epoch"); } })
            .select("d.*", "t.slug as type").orderBy("d.last_seen_epoch", "asc", "first").orderBy("d.name", "asc");
        if (req.query.account !== undefined)
        {
            const ids = await accountLocationIds(req.query.account, locs);
            if (!ids) { return none(); }
            q.whereIn("d.location_id", ids);
        }
        if (!applyScopeFilters(req, q, locs)) { return none(); }
        const rows = await q;
        res.json({ minutes: minutes, cutoff_epoch: cutoff, devices: rows.map((d) =>
        {
            const seen = num(d.last_seen_epoch);
            return { uid: uidOf(d.uid), name: d.name, type: d.type, kind: d.kind, hardware_id: d.hardware_id, location: uidOf(locs.get(d.location_id).uid),
                last_seen_epoch: seen, silent_secs: seen === null ? null : now - seen };
        }) });
    }
    catch (err) { next(err); }
});

router.get("/sensors", async (req, res, next) =>
{
    try
    {
        const locs = await locationsMap(req);
        if (!locs.size) { return res.json({ sensors: [] }); }
        const q = knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").whereIn("d.location_id", Array.from(locs.keys())).whereNull("s.delete_epoch").whereNull("d.delete_epoch").select("s.*", "d.uid as device_uid", "d.location_id");
        if (req.query.device !== undefined) { if (!isUuid(req.query.device)) { return res.json({ sensors: [] }); } q.where("d.uid", req.query.device); }
        const rows = await q;
        const out = [];
        for (const s of rows)
        {
            const loc = locs.get(s.location_id);
            const unit = await display.resolveUnit(s, loc);
            out.push({ uid: uidOf(s.uid), device: uidOf(s.device_uid), channel: s.channel_id, name: s.name, metric: s.metric, canonical_unit: metrics.get(s.metric).canonical, display_unit: unit,
                last_value: s.last_value, last_display: await display.format(s, s.last_value, loc), last_epoch: s.last_epoch === null ? null : Number(s.last_epoch) });
        }
        res.json({ sensors: out });
    }
    catch (err) { next(err); }
});

router.get("/devices/:uid", async (req, res, next) =>
{
    try
    {
        const d = await knex(T("devices") + " as d").join(T("device_types") + " as t", "t.id", "d.device_type_id").where("d.uid", req.params.uid).whereNull("d.delete_epoch").select("d.*", "t.slug as type").first();
        const l = d ? await knex(T("locations")).where({ id: d.location_id }).whereNull("delete_epoch").first() : null;
        if (!l || !permissions.has(apiAuth.bitsAt(req, l), permissions.byName.view)) { return res.status(404).json({ error: "Device not found" }); }
        const sensors = await knex(T("sensors")).where({ device_id: d.id }).whereNull("delete_epoch").orderBy([{ column: "sort_order", order: "asc" }, { column: "id", order: "asc" }]);
        const status = await alarmStatus(sensors.map((s) => s.id));
        const out = [];
        let worst = "ok";
        for (const s of sensors)
        {
            const st = status.get(s.id);
            worst = worse(worst, st.alarm_status);
            out.push(await sensorOut(Object.assign({ device_uid: d.uid }, s), l, st));
        }
        res.json({ device: { uid: uidOf(d.uid), name: d.name, type: d.type, kind: d.kind, hardware_id: d.hardware_id, model: d.model, firmware: d.firmware, location: locationOut(l),
            last_seen_epoch: num(d.last_seen_epoch), is_offline: !!d.is_offline, is_archived: !!d.is_archived, alarm_status: worst, sensors: out } });
    }
    catch (err) { next(err); }
});

router.get("/sensors/:uid", async (req, res, next) =>
{
    try
    {
        const s = await knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").where("s.uid", req.params.uid).whereNull("s.delete_epoch").whereNull("d.delete_epoch")
            .select("s.*", "d.uid as device_uid", "d.name as device_name", "d.location_id").first();
        const l = s ? await knex(T("locations")).where({ id: s.location_id }).whereNull("delete_epoch").first() : null;
        if (!l || !permissions.has(apiAuth.bitsAt(req, l), permissions.byName.view)) { return res.status(404).json({ error: "Sensor not found" }); }
        const status = await alarmStatus([s.id]);
        const out = await sensorOut(s, l, status.get(s.id));
        res.json({ sensor: Object.assign(out, { device_name: s.device_name, location: locationOut(l) }) });
    }
    catch (err) { next(err); }
});

router.get("/readings", async (req, res, next) =>
{
    try
    {
        const sensorUid = String(req.query.sensor || "");
        const s = require("../middleware/account").isUuid(sensorUid) ? await knex(T("sensors")).where({ uid: sensorUid }).whereNull("delete_epoch").first() : null;
        const d = s ? await knex(T("devices")).where({ id: s.device_id }).first() : null;
        const l = d ? await knex(T("locations")).where({ id: d.location_id }).first() : null;
        if (!l || !permissions.has(apiAuth.bitsAt(req, l), permissions.byName.view)) { return res.status(404).json({ error: "Sensor not found" }); }
        const { from, to } = rangeOf(req);
        const limit = limitOf(req.query.limit, 5000, 20000);
        const unit = await display.resolveUnit(s, l);
        const rows = await knex(T("readings")).where({ sensor_id: s.id }).where("epoch", ">=", from).where("epoch", "<=", to).orderBy("epoch").limit(limit + 1).select("epoch", "value");
        const pg = pageByEpoch(rows, limit, "epoch");
        res.json({ sensor: uidOf(s.uid), metric: s.metric, canonical_unit: metrics.get(s.metric).canonical, display_unit: unit, from: from, to: to, truncated: pg.truncated, next_from: pg.next_from,
            readings: pg.rows.map((r) => ({ epoch: Number(r.epoch), value: r.value, display_value: Number(metrics.fromCanonical(s.metric, r.value, unit).toFixed(metrics.precision(s.metric, unit))) })) });
    }
    catch (err) { next(err); }
});

// Bulk insert for direct devices: [{ sensor, value, unit?, epoch? }]; grouped per device and
// handed to the pipeline exactly like a frame (architecture 10). Partial success is reported.
router.post("/readings", async (req, res, next) =>
{
    try
    {
        const items = Array.isArray(req.body) ? req.body : (req.body && Array.isArray(req.body.readings) ? req.body.readings : null);
        if (!items) { return res.status(400).json({ error: "Body must be an array of readings or { readings: [...] }" }); }
        const max = settings.get("API_MAX_OBJECTS", 1000);
        if (items.length > max) { return res.status(413).json({ error: "At most " + max + " readings per request" }); }
        const byDevice = new Map();
        const rejected = [];
        for (let i = 0; i < items.length; i++)
        {
            const it = items[i] || {};
            const s = it.sensor && require("../middleware/account").isUuid(String(it.sensor)) ? await knex(T("sensors")).where({ uid: String(it.sensor) }).whereNull("delete_epoch").first() : null;
            const d = s ? await knex(T("devices")).where({ id: s.device_id }).whereNull("delete_epoch").first() : null;
            const l = d ? await knex(T("locations")).where({ id: d.location_id }).first() : null;
            if (!l || !permissions.has(apiAuth.bitsAt(req, l), permissions.byName.api_write)) { rejected.push({ index: i, error: "sensor not found or not writable" }); continue; }
            if (d.kind !== "direct") { rejected.push({ index: i, error: "only direct devices accept API readings" }); continue; }
            const tr = await knex(T("device_types")).where({ id: d.device_type_id }).first();
            if (!tr || !deviceTypes.get(tr.slug).apiWrite) { rejected.push({ index: i, error: "this device type does not accept API readings" }); continue; }
            if (typeof it.value !== "number" || !Number.isFinite(it.value)) { rejected.push({ index: i, error: "value must be a finite number" }); continue; }
            const m = metrics.get(s.metric);
            const unit = it.unit || m.canonical;
            if (unit !== m.canonical && !m.units[unit]) { rejected.push({ index: i, error: "unit " + unit + " not valid for " + s.metric }); continue; }
            const epoch = it.epoch ? Number(it.epoch) : nowEpoch();
            if (!Number.isFinite(epoch) || epoch > nowEpoch() + 300) { rejected.push({ index: i, error: "epoch invalid or in the future" }); continue; }
            const key = d.id + ":" + epoch;
            if (!byDevice.has(key)) { byDevice.set(key, { device: d, epoch: epoch, values: {} }); }
            byDevice.get(key).values[s.channel_id] = metrics.toCanonical(s.metric, it.value, unit);
        }
        let accepted = 0;
        for (const g of byDevice.values())
        {
            const typeRow = await knex(T("device_types")).where({ id: g.device.device_type_id }).first();
            const r = await pipeline.ingest({ device: g.device, type: deviceTypes.get(typeRow.slug), epoch: g.epoch, values: g.values, canonical: true, gatewayId: g.device.id });
            accepted += r.accepted.length;
        }
        await activity.log(req, "api_readings", { detail: accepted + " accepted, " + rejected.length + " rejected" });
        res.status(rejected.length && !accepted ? 422 : 200).json({ accepted: accepted, rejected: rejected });
    }
    catch (err) { next(err); }
});

// Readings for one device, by channel (architecture 12): one object or an array of
// { epoch?, data: { channel: value, ... } }, canonical units. The whole request is checked before
// anything is stored: an unknown channel rejects it and lists the valid channels; a bad value, a
// missing data object or an epoch more than 5 minutes ahead rejects it with the object's index.
// Backdated epochs are fine (buffered uploads; the hot column guard keeps the current value). A
// channel that already has a reading at that epoch is skipped as a duplicate, so a retried upload
// stores nothing twice. Each object then enters the pipeline at stage 2, exactly like a frame. Only
// a live, unarchived device whose type declares apiWrite is accepted (403 otherwise); a direct device
// is its own gateway, others keep the gateway that last heard them.
router.post("/devices/:uid/readings", async (req, res, next) =>
{
    try
    {
        const d = await knex(T("devices")).where({ uid: req.params.uid }).whereNull("delete_epoch").first();
        const l = d && !d.is_archived ? await knex(T("locations")).where({ id: d.location_id }).whereNull("delete_epoch").first() : null;
        if (!l || !permissions.has(apiAuth.bitsAt(req, l), permissions.byName.api_write)) { return res.status(404).json({ error: "Device not found" }); }
        const typeRow = await knex(T("device_types")).where({ id: d.device_type_id }).first();
        const type = deviceTypes.get(typeRow.slug);
        // Only types that declare apiWrite take API readings (DECISIONS "API writes need apiWrite").
        if (!type.apiWrite) { return res.status(403).json({ error: "This device type does not accept API readings" }); }

        const items = Array.isArray(req.body) ? req.body : (req.body && typeof req.body === "object" ? [req.body] : null);
        if (!items || !items.length) { return res.status(400).json({ error: "Body must be { epoch?, data: { channel: value } } or an array of them" }); }
        const max = settings.get("API_MAX_OBJECTS", 1000);
        if (items.length > max) { return res.status(413).json({ error: "At most " + max + " objects per request" }); }

        const now = nowEpoch();
        const valid = type.channels.filter((c) => !c.perGateway).map((c) => c.id);
        const objects = [];
        for (let i = 0; i < items.length; i++)
        {
            const it = items[i];
            if (!it || typeof it !== "object" || Array.isArray(it) || !it.data || typeof it.data !== "object" || Array.isArray(it.data) || !Object.keys(it.data).length)
            {
                return res.status(400).json({ error: "data must be an object of channel values", index: i });
            }
            const unknown = Object.keys(it.data).filter((c) => !deviceTypes.channelDef(type, c));
            if (unknown.length) { return res.status(400).json({ error: "Unknown channel " + unknown.join(", "), index: i, valid_channels: valid }); }
            const bad = Object.keys(it.data).filter((c) => typeof it.data[c] !== "boolean" && !(typeof it.data[c] === "number" && Number.isFinite(it.data[c])));
            if (bad.length) { return res.status(400).json({ error: "Values must be finite numbers or booleans: " + bad.join(", "), index: i }); }
            let epoch = now;
            if (it.epoch !== undefined && it.epoch !== null)
            {
                epoch = Math.floor(Number(it.epoch));
                if (!Number.isFinite(epoch) || epoch < 0) { return res.status(400).json({ error: "epoch must be epoch seconds", index: i }); }
                if (epoch > now + 300) { return res.status(400).json({ error: "epoch is more than 5 minutes in the future", index: i }); }
            }
            objects.push({ epoch: epoch, data: it.data });
        }

        const results = [];
        let accepted = 0;
        let deduped = 0;
        for (let i = 0; i < objects.length; i++)
        {
            const o = objects[i];
            const sensors = await knex(T("sensors")).where({ device_id: d.id }).whereNull("delete_epoch").whereIn("channel_id", Object.keys(o.data)).select("id", "channel_id");
            const stored = sensors.length ? new Set((await knex(T("readings")).whereIn("sensor_id", sensors.map((x) => x.id)).where({ epoch: o.epoch }).select("sensor_id")).map((r) => r.sensor_id)) : new Set();
            const dupes = sensors.filter((x) => stored.has(x.id)).map((x) => x.channel_id);
            const values = Object.fromEntries(Object.entries(o.data).filter((e) => !dupes.includes(e[0])));
            let r = { accepted: [], skipped: [] };
            if (Object.keys(values).length) { r = await pipeline.ingest({ device: d, type: type, epoch: o.epoch, values: values, canonical: true, gatewayId: d.kind === "direct" ? d.id : undefined }); }
            const n = r.accepted.filter((a) => Object.prototype.hasOwnProperty.call(values, a.channel)).length;
            accepted += n;
            deduped += dupes.length;
            results.push({ index: i, epoch: o.epoch, accepted: n, deduped: dupes, skipped: r.skipped.filter((c) => Object.prototype.hasOwnProperty.call(values, c)) });
        }
        await activity.log(req, "api_device_readings", { entity_type: "device", entity_uid: d.uid, detail: objects.length + " objects, " + accepted + " values accepted, " + deduped + " duplicates" });
        res.json({ device: uidOf(d.uid), accepted: accepted, deduped: deduped, results: results });
    }
    catch (err) { next(err); }
});

// Alarms raised between from and to (inclusive), oldest first, active or cleared, in the locations the
// key can view, deleted sensors and devices included (DECISIONS "API range paging"). severity is the
// current (or final) severity; highest_severity is the worst it reached, from its events, because the
// ladder changes severity in place.
router.get("/alarms/history", async (req, res, next) =>
{
    try
    {
        const scopeErr = missingScope(req.query, ["location", "device", "sensor"]);
        if (scopeErr) { return res.status(400).json({ error: scopeErr }); }
        const now = nowEpoch();
        const { from, to } = rangeOf(req);
        const limit = limitOf(req.query.limit, 500, 1000);
        const none = () => res.json({ from: from, to: to, truncated: false, next_from: null, alarms: [] });
        const locs = await locationsMap(req);
        if (!locs.size) { return none(); }
        const q = knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id")
            .whereIn("d.location_id", Array.from(locs.keys())).where("a.raised_epoch", ">=", from).where("a.raised_epoch", "<=", to)
            .select(ALARM_LIST_COLUMNS).orderBy([{ column: "a.raised_epoch", order: "asc" }, { column: "a.id", order: "asc" }]).limit(limit + 1);
        if (!applyScopeFilters(req, q, locs)) { return none(); }
        const pg = pageByEpoch(await q, limit, "raised_epoch");
        const highest = new Map(pg.rows.map((a) => [a.id, a.severity]));
        if (pg.rows.length)
        {
            const ev = await knex(T("alarm_events")).whereIn("alarm_id", pg.rows.map((a) => a.id)).whereNotNull("severity").select("alarm_id", "severity");
            for (const e of ev) { highest.set(e.alarm_id, worse(highest.get(e.alarm_id), e.severity)); }
        }
        const names = await alarmNames(pg.rows, locs);
        res.json({ from: from, to: to, truncated: pg.truncated, next_from: pg.next_from, alarms: pg.rows.map((a) =>
        {
            const raised = Number(a.raised_epoch);
            const cleared = num(a.cleared_epoch);
            return { uid: uidOf(a.uid), name: names.get(a.id), sensor: uidOf(a.sensor_uid), sensor_name: a.sensor_name, device: uidOf(a.device_uid), device_name: a.device_name, location: uidOf(locs.get(a.location_id).uid),
                direction: a.direction, severity: a.severity, highest_severity: highest.get(a.id), raised_epoch: raised, cleared_epoch: cleared, is_active: cleared === null,
                duration_secs: (cleared === null ? now : cleared) - raised, clear_reason: a.clear_reason, acknowledged: !!a.acked_epoch, suppressed: !!a.suppressed_by,
                trigger_value: a.trigger_value, canonical_unit: metrics.get(a.metric).canonical };
        }) });
    }
    catch (err) { next(err); }
});

// Alarms active now in one account, location, device or sensor (DECISIONS "API queries are scoped").
router.get("/alarms/active", async (req, res, next) =>
{
    try
    {
        const scopeErr = missingScope(req.query, ["account", "location", "device", "sensor"]);
        if (scopeErr) { return res.status(400).json({ error: scopeErr }); }
        const locs = await locationsMap(req);
        if (!locs.size) { return res.json({ alarms: [] }); }
        const q = knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id")
            .whereIn("d.location_id", Array.from(locs.keys())).whereNull("a.cleared_epoch").select(ALARM_LIST_COLUMNS);
        if (req.query.account !== undefined)
        {
            const ids = await accountLocationIds(req.query.account, locs);
            if (!ids) { return res.json({ alarms: [] }); }
            q.whereIn("d.location_id", ids);
        }
        if (!applyScopeFilters(req, q, locs)) { return res.json({ alarms: [] }); }
        const rows = await q;
        const names = await alarmNames(rows, locs);
        res.json({ alarms: rows.map((a) => ({ uid: uidOf(a.uid), name: names.get(a.id), severity: a.severity, direction: a.direction, raised_epoch: Number(a.raised_epoch), acknowledged: !!a.acked_epoch, suppressed: !!a.suppressed_by,
            sensor: uidOf(a.sensor_uid), sensor_name: a.sensor_name, device: uidOf(a.device_uid), device_name: a.device_name, location: uidOf(locs.get(a.location_id).uid), trigger_value: a.trigger_value })) });
    }
    catch (err) { next(err); }
});

// Everything about one alarm (DECISIONS "API alarm detail"): the same events, notifications and
// escalations routes/alarms.js loads, with uids in place of ids. Values are canonical; display_unit and
// the *_display strings are what the pages show.
router.get("/alarms/:uid", async (req, res, next) =>
{
    try
    {
        const found = await alarmsRepo.findByUid(req.params.uid);
        const a = found ? await alarmsRepo.context(found.id) : null;
        if (!a || !permissions.has(apiAuth.bitsAt(req, { id: a.location_id, account_id: a.account_id }), permissions.byName.view)) { return res.status(404).json({ error: "Alarm not found" }); }

        const canonical = metrics.get(a.metric).canonical;
        const unit = await display.resolveUnit(a, { id: a.location_id, account_id: a.account_id });
        const shown = shownIn(a.metric, unit, a.display_precision);
        const events = await knex(T("alarm_events") + " as e")
            .leftJoin(T("users") + " as u", function () { this.on("u.id", "e.actor_id").andOnVal("e.actor_type", "=", "user"); })
            .leftJoin(T("api_credentials") + " as c", function () { this.on("c.id", "e.actor_id").andOnVal("e.actor_type", "=", "api_credential"); })
            .where("e.alarm_id", a.id).select("e.*", "u.username as user_name", "c.name as credential_name").orderBy([{ column: "e.epoch", order: "asc" }, { column: "e.id", order: "asc" }]);
        const notes = events.length ? await knex(T("notifications")).whereIn("alarm_event_id", events.map((e) => e.id)).orderBy([{ column: "epoch", order: "asc" }, { column: "id", order: "asc" }]) : [];
        const escalations = await knex(T("alarm_escalations") + " as x").join(T("alert_groups") + " as g", "g.id", "x.alert_group_id").where("x.alarm_id", a.id).select("x.*", "g.uid as group_uid", "g.name as group_name");
        const rule = a.rule_id ? await knex(T("alarm_rules")).where({ id: a.rule_id }).first() : null;
        const ackedBy = a.acked_by ? await knex(T("users")).where({ id: a.acked_by }).select("username").first() : null;
        const name = await titleOf(a, rule);

        let highest = a.severity;
        for (const e of events) { if (e.severity) { highest = worse(highest, e.severity); } }
        const raised = Number(a.raised_epoch);
        const cleared = num(a.cleared_epoch);
        res.json({ alarm:
        {
            uid: uidOf(a.uid), name: name, direction: a.direction, severity: a.severity, highest_severity: highest,
            raised_epoch: raised, cleared_epoch: cleared, is_active: cleared === null, duration_secs: (cleared === null ? nowEpoch() : cleared) - raised, clear_reason: a.clear_reason,
            acknowledged: !!a.acked_epoch, acked_epoch: num(a.acked_epoch), acked_by: ackedBy ? ackedBy.username : null, ack_until_epoch: num(a.ack_until_epoch), suppressed: !!a.suppressed_by,
            trigger_value: a.trigger_value, trigger_display: shown(a.trigger_value), canonical_unit: canonical, display_unit: unit,
            sensor: { uid: uidOf(a.sensor_uid), name: a.sensor_name, channel: a.channel_id, metric: a.metric },
            device: { uid: uidOf(a.device_uid), name: a.device_name },
            location: { uid: uidOf(a.location_uid), name: a.location_name, timezone: a.iana_timezone },
            account: { uid: uidOf(a.account_uid), name: a.account_name },
            rule: rule ? { uid: uidOf(rule.uid), kind: rule.rule_kind, direction: rule.direction, threshold: rule.threshold, threshold_display: shown(rule.threshold), severity: rule.severity,
                exceed_secs: rule.exceed_secs, return_secs: rule.return_secs, timeout_secs: rule.timeout_secs, is_enabled: !!rule.is_enabled, is_deleted: rule.delete_epoch !== null } : null,
            events: events.map((e) => (
            {
                epoch: Number(e.epoch), kind: e.event_kind, severity: e.severity, value: e.value, value_display: shown(e.value), comment: e.comment,
                actor: { type: e.actor_type || "system", name: e.actor_type === "user" ? e.user_name : (e.actor_type === "api_credential" ? e.credential_name : null) },
                notifications: notes.filter((n) => n.alarm_event_id === e.id).map((n) => (
                {
                    epoch: Number(n.epoch), channel: n.channel, outcome: n.outcome, reason: n.reason, to: n.address, recipient_type: n.recipient_type, ladder: n.ladder_note, subject: n.subject
                }))
            })),
            escalations: escalations.map((x) => ({ alert_group: uidOf(x.group_uid), alert_group_name: x.group_name, level: x.current_level, level_entered_epoch: Number(x.level_entered_epoch), is_stopped: !!x.is_stopped }))
        } });
    }
    catch (err) { next(err); }
});

// Alarm rules in force now (live rules on live sensors and devices) in the locations the key can view.
// Unpaged: rule counts are small.
router.get("/alarm-rules", async (req, res, next) =>
{
    try
    {
        const scopeErr = missingScope(req.query, ["location", "device", "sensor"]);
        if (scopeErr) { return res.status(400).json({ error: scopeErr }); }
        const locs = await locationsMap(req);
        if (!locs.size) { return res.json({ rules: [] }); }
        const q = knex(T("alarm_rules") + " as r").join(T("sensors") + " as s", "s.id", "r.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id")
            .whereIn("d.location_id", Array.from(locs.keys())).whereNull("r.delete_epoch").whereNull("s.delete_epoch").whereNull("d.delete_epoch")
            .select("r.*", "s.uid as sensor_uid", "s.name as sensor_name", "s.metric", "s.display_unit", "s.display_precision", "d.uid as device_uid", "d.name as device_name", "d.location_id")
            .orderBy([{ column: "d.name", order: "asc" }, { column: "s.sort_order", order: "asc" }, { column: "r.rule_kind", order: "asc" }, { column: "r.direction", order: "asc" }, { column: "r.threshold", order: "asc" }]);
        if (!applyScopeFilters(req, q, locs)) { return res.json({ rules: [] }); }
        const rows = await q;
        const groups = rows.length ? await knex(T("alarm_rule_alert_groups") + " as rg").join(T("alert_groups") + " as g", "g.id", "rg.alert_group_id")
            .whereIn("rg.alarm_rule_id", rows.map((r) => r.id)).select("rg.alarm_rule_id", "g.uid", "g.name").orderBy("g.name") : [];
        const out = [];
        for (const r of rows)
        {
            const loc = locs.get(r.location_id);
            const unit = await display.resolveUnit(r, loc);
            out.push({ uid: uidOf(r.uid), sensor: uidOf(r.sensor_uid), sensor_name: r.sensor_name, device: uidOf(r.device_uid), device_name: r.device_name, location: uidOf(loc.uid),
                kind: r.rule_kind, direction: r.direction, threshold: r.threshold, threshold_display: shownIn(r.metric, unit, r.display_precision)(r.threshold),
                canonical_unit: metrics.get(r.metric).canonical, display_unit: unit, severity: r.severity, exceed_secs: r.exceed_secs, return_secs: r.return_secs, timeout_secs: r.timeout_secs,
                is_enabled: !!r.is_enabled, use_default_group: !!r.use_default_group, channel_policy: parseJson(r.channel_policy), alarm_title: r.alarm_title,
                chart_in_alarm: !!r.chart_in_alarm, chart_window_secs: r.chart_window_secs === null || r.chart_window_secs === undefined ? null : Number(r.chart_window_secs),
                alert_groups: groups.filter((g) => g.alarm_rule_id === r.id).map((g) => ({ uid: uidOf(g.uid), name: g.name })), created_epoch: Number(r.created_epoch) });
        }
        res.json({ rules: out });
    }
    catch (err) { next(err); }
});

// The alarm rule change log (services/alarms/ruleLog.js) of one rule (DECISIONS "API queries are
// scoped"): audit rows keyed to that rule, between from and to, oldest first, when the rule is in a
// location the key can view; deleted rules, sensors and devices included.
// Values come back typed; the display text comes from services/alarms/ruleHistory.js, so the API and
// the sensor page word a change the same way. Paged like the other range endpoints.
router.get("/alarm-rules/changes", async (req, res, next) =>
{
    try
    {
        const scopeErr = missingScope(req.query, ["rule"]);
        if (scopeErr) { return res.status(400).json({ error: scopeErr }); }
        // The rule's whole history unless from is given (DECISIONS "API queries are scoped").
        const range = rangeOf(req);
        const to = range.to;
        const from = epochOf(req.query.from) === null ? 0 : range.from;
        const limit = limitOf(req.query.limit, 500, 1000);
        const none = () => res.json({ from: from, to: to, truncated: false, next_from: null, changes: [] });
        const locs = await locationsMap(req);
        if (!locs.size) { return none(); }
        const q = knex(T("audit_log") + " as x").join(T("alarm_rules") + " as r", "r.uid", "x.entity_uid").join(T("sensors") + " as s", "s.id", "r.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id")
            .where("x.entity_type", "alarm_rule").whereIn("d.location_id", Array.from(locs.keys())).where("x.epoch", ">=", from).where("x.epoch", "<=", to)
            .select("x.*", "r.uid as rule_uid", "s.uid as sensor_uid", "s.name as sensor_name", "s.metric", "s.display_unit", "d.uid as device_uid", "d.name as device_name", "d.location_id")
            .orderBy([{ column: "x.epoch", order: "asc" }, { column: "x.id", order: "asc" }]).limit(limit + 1);
        if (!isUuid(String(req.query.rule))) { return none(); }
        q.where("r.uid", String(req.query.rule));
        const pg = pageByEpoch(await q, limit, "epoch");
        const out = [];
        for (const x of pg.rows)
        {
            const loc = locs.get(x.location_id);
            const unit = await display.resolveUnit(x, loc);
            const l = ruleHistory.line(x, { threshold: shownIn(x.metric, unit) });
            out.push({ epoch: Number(x.epoch), rule: uidOf(x.rule_uid), sensor: uidOf(x.sensor_uid), sensor_name: x.sensor_name, device: uidOf(x.device_uid), device_name: x.device_name, location: uidOf(loc.uid),
                change: x.field, old_value: typedValue(x.field, x.old_value), new_value: typedValue(x.field, x.new_value), old_display: l.before || null, new_display: l.after || null,
                actor: { type: x.actor_type, name: x.actor_type === "system" ? null : x.actor_name } });
        }
        res.json({ from: from, to: to, truncated: pg.truncated, next_from: pg.next_from, changes: out });
    }
    catch (err) { next(err); }
});

router.post("/alarms/:uid/:action", async (req, res, next) =>
{
    try
    {
        const a = await alarmsRepo.findByUid(req.params.uid);
        const ctx = a ? await alarmsRepo.context(a.id) : null;
        if (!ctx) { return res.status(404).json({ error: "Alarm not found" }); }
        // Denied and missing look identical: the permission is checked before anything that would
        // tell a key without it that the alarm exists (400, 409).
        const bits = apiAuth.bitsAt(req, { id: ctx.location_id, account_id: ctx.account_id });
        const need = { ack: permissions.byName.ack_alarm, clear: permissions.byName.clear_alarm }[req.params.action];
        if (!need || !permissions.has(bits, need)) { return res.status(404).json({ error: "Alarm not found" }); }
        const comment = String((req.body && req.body.comment) || "").trim().slice(0, 500);
        if (!comment) { return res.status(400).json({ error: "comment is required" }); }
        if (ctx.cleared_epoch) { return res.status(409).json({ error: "Alarm already cleared" }); }
        const actor = { type: "api_credential", id: req.apiCredential.id, name: req.apiCredential.name };
        if (req.params.action === "ack") { await actions.acknowledge(ctx, Number(req.body.minutes) || 60, comment, actor); }
        else { await actions.clear(ctx, comment, actor); }
        res.json({ ok: true });
    }
    catch (err) { next(err); }
});

router.use((req, res) => res.status(404).json({ error: "Unknown endpoint" }));

module.exports = router;
