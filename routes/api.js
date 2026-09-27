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

router.get("/sensors", async (req, res, next) =>
{
    try
    {
        const locs = await locationsMap(req);
        if (!locs.size) { return res.json({ sensors: [] }); }
        const q = knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").whereIn("d.location_id", Array.from(locs.keys())).whereNull("s.delete_epoch").whereNull("d.delete_epoch").select("s.*", "d.uid as device_uid", "d.location_id");
        if (req.query.device) { q.where("d.uid", String(req.query.device)); }
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

router.get("/readings", async (req, res, next) =>
{
    try
    {
        const sensorUid = String(req.query.sensor || "");
        const s = require("../middleware/account").isUuid(sensorUid) ? await knex(T("sensors")).where({ uid: sensorUid }).whereNull("delete_epoch").first() : null;
        const d = s ? await knex(T("devices")).where({ id: s.device_id }).first() : null;
        const l = d ? await knex(T("locations")).where({ id: d.location_id }).first() : null;
        if (!l || !permissions.has(apiAuth.bitsAt(req, l), permissions.byName.view)) { return res.status(404).json({ error: "Sensor not found" }); }
        const to = Number(req.query.to) || nowEpoch();
        const from = Number(req.query.from) || (to - 86400);
        const limit = Math.min(Number(req.query.limit) || 5000, 20000);
        const unit = await display.resolveUnit(s, l);
        const rows = await knex(T("readings")).where({ sensor_id: s.id }).where("epoch", ">=", from).where("epoch", "<=", to).orderBy("epoch").limit(limit).select("epoch", "value");
        res.json({ sensor: uidOf(s.uid), metric: s.metric, canonical_unit: metrics.get(s.metric).canonical, display_unit: unit, from: from, to: to,
            readings: rows.map((r) => ({ epoch: Number(r.epoch), value: r.value, display_value: Number(metrics.fromCanonical(s.metric, r.value, unit).toFixed(metrics.precision(s.metric, unit))) })) });
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
            if (d.kind !== "direct" && d.kind !== "asset") { rejected.push({ index: i, error: "only direct devices accept API readings" }); continue; }
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

router.get("/alarms/active", async (req, res, next) =>
{
    try
    {
        const locs = await locationsMap(req);
        if (!locs.size) { return res.json({ alarms: [] }); }
        const rows = await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id")
            .whereIn("d.location_id", Array.from(locs.keys())).whereNull("a.cleared_epoch").select("a.*", "s.uid as sensor_uid", "s.name as sensor_name", "d.uid as device_uid", "d.name as device_name", "d.location_id");
        res.json({ alarms: rows.map((a) => ({ uid: uidOf(a.uid), severity: a.severity, direction: a.direction, raised_epoch: Number(a.raised_epoch), acknowledged: !!a.acked_epoch, suppressed: !!a.suppressed_by,
            sensor: uidOf(a.sensor_uid), sensor_name: a.sensor_name, device: uidOf(a.device_uid), device_name: a.device_name, location: uidOf(locs.get(a.location_id).uid), trigger_value: a.trigger_value })) });
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
        const bits = apiAuth.bitsAt(req, { id: ctx.location_id, account_id: ctx.account_id });
        const comment = String((req.body && req.body.comment) || "").trim().slice(0, 500);
        if (!comment) { return res.status(400).json({ error: "comment is required" }); }
        if (ctx.cleared_epoch) { return res.status(409).json({ error: "Alarm already cleared" }); }
        const actor = { type: "api_credential", id: req.apiCredential.id, name: req.apiCredential.name };
        if (req.params.action === "ack" && permissions.has(bits, permissions.byName.ack_alarm)) { await actions.acknowledge(ctx, Number(req.body.minutes) || 60, comment, actor); }
        else if (req.params.action === "clear" && permissions.has(bits, permissions.byName.clear_alarm)) { await actions.clear(ctx, comment, actor); }
        else { return res.status(404).json({ error: "Alarm not found" }); }
        res.json({ ok: true });
    }
    catch (err) { next(err); }
});

router.use((req, res) => res.status(404).json({ error: "Unknown endpoint" }));

module.exports = router;
