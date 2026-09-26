const express = require("express");
const { notFoundError } = require("../middleware/errors");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch, insertId } = require("../db/knex");
const { requireLogin } = require("../middleware/auth");
const permissions = require("../permissions");
const grants = require("../services/grants");
const metrics = require("../metrics");
const display = require("../services/display");
const sensorsExt = require("../db/repos/sensorsExt");
const { audit } = require("../services/audit");
const activity = require("../services/activity");
const deviceTypes = require("../deviceTypes");
const tagsSvc = require("../services/tags");
const tagsRepo = require("../db/repos/tags");

const router = express.Router();
router.use(requireLogin);

async function loadSensor(req, res, next)
{
    try
    {
        const s = await sensorsExt.context(req.params.uid);
        if (!s) { return next(notFoundError()); }
        const location = { id: s.location_id, account_id: s.account_id, uid: s.location_uid, name: s.location_name, iana_timezone: s.iana_timezone };
        const bits = await grants.effectiveAtLocation(req, location);
        if (!permissions.has(bits, permissions.byName.view)) { return next(notFoundError()); }
        req.sensor = s; req.location = location; req.bits = bits;
        require("../middleware/account").enterLocation(req, { id: s.location_id, account_id: s.account_id, uid: s.location_uid, name: s.location_name, iana_timezone: s.iana_timezone, alarm_mode: null });
        req.unit = await display.resolveUnit(s, location);
        req.metric = metrics.get(s.metric);
        next();
    }
    catch (err) { next(err); }
}

function need(bitName)
{
    return (req, res, next) =>
    {
        if (!permissions.has(req.bits, permissions.byName[bitName])) { return next(notFoundError()); }
        next();
    };
}

function trail(req, extra)
{
    const s = req.sensor;
    const t = [
        { label: "Account", path: "/account" }, { label: s.location_name, path: "/locations/" + String(s.location_uid).toLowerCase() },
        { label: s.device_name, path: "/devices/" + String(s.device_uid).toLowerCase() }, { label: s.name, path: "/sensors/" + String(s.uid).toLowerCase(), isCurrent: !extra }
    ];
    if (extra) { t.push({ label: extra, path: "", isCurrent: true }); }
    return t;
}

function tabs(req, current)
{
    const base = "/sensors/" + String(req.sensor.uid).toLowerCase();
    return [{ label: "Overview", path: base }, { label: "Alarm rules", path: base + "/rules" }, { label: "Tags", path: base + "/tags" }, { label: "Settings", path: base + "/settings" }].map((t) => ({ label: t.label, path: t.path, active: t.label === current }));
}

// The device type channel's description: the default a sensor shows until it has its own.
function channelDescription(sensor)
{
    const type = deviceTypes.all[sensor.device_type_slug];
    const ch = type ? deviceTypes.channelDef(type, sensor.channel_id) : null;
    return ch && ch.description ? ch.description : null;
}

function toDisplay(req, v) { return v === null || v === undefined ? null : metrics.fromCanonical(req.sensor.metric, v, req.unit); }
function fromDisplay(req, v) { return metrics.toCanonical(req.sensor.metric, v, req.unit); }

router.get("/:uid", loadSensor, async (req, res, next) =>
{
    try
    {
        const s = req.sensor;
        const active = await knex(T("alarms")).where({ sensor_id: s.id }).whereNull("cleared_epoch").orderBy("raised_epoch", "desc");
        const rules = await sensorsExt.rules(s.id);
        const history = await knex(T("alarms")).where({ sensor_id: s.id }).whereNotNull("cleared_epoch").orderBy("raised_epoch", "desc").limit(10);
        res.render("sensors/show", {
            title: s.name, sensor: s, location: req.location, unit: req.unit, precision: s.display_precision !== null ? s.display_precision : metrics.precision(s.metric, req.unit),
            value: await display.format(s, s.last_value, req.location), active: active, rules: rules.map((r) => Object.assign({}, r, { thresholdDisplay: toDisplay(req, r.threshold) })),
            history: history, bits: req.bits, permissions: permissions, navTrail: trail(req), navSub: tabs(req, "Overview"), range: req.query.range || "24h",
            descriptionDefault: channelDescription(s)
        });
    }
    catch (err) { next(err); }
});

// Chart data in display units. range: 1h, 24h, 7d, 30d; larger windows are bucketed by the chart step.
router.get("/:uid/data", loadSensor, async (req, res, next) =>
{
    try
    {
        const spans = { "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
        const span = spans[req.query.range] || spans["24h"];
        const to = nowEpoch();
        const from = to - span;
        const rows = await sensorsExt.readings(req.sensor.id, from, to, 20000);
        const step = Math.max(1, Math.ceil(rows.length / 2000));
        const points = [];
        for (let i = 0; i < rows.length; i += step)
        {
            const chunk = rows.slice(i, i + step);
            const avg = chunk.reduce((a, r) => a + r.value, 0) / chunk.length;
            points.push([Number(chunk[chunk.length - 1].epoch) * 1000, Number(toDisplay(req, avg).toFixed(4))]);
        }
        const rules = (await sensorsExt.rules(req.sensor.id)).filter((r) => r.rule_kind === "threshold" && r.is_enabled).map((r) => ({ direction: r.direction, severity: r.severity, value: toDisplay(req, r.threshold) }));
        res.json({ unit: req.unit, timezone: req.location.iana_timezone, points: points, rules: rules, from: from * 1000, to: to * 1000 });
    }
    catch (err) { next(err); }
});

router.get("/:uid/rules", loadSensor, async (req, res, next) =>
{
    try
    {
        const rules = await sensorsExt.rules(req.sensor.id);
        const groups = await knex(T("alert_groups")).where({ account_id: req.location.account_id }).whereNull("delete_epoch").orderBy("name");
        for (const r of rules)
        {
            r.thresholdDisplay = toDisplay(req, r.threshold);
            r.groups = (await knex(T("alarm_rule_alert_groups")).where({ alarm_rule_id: r.id })).map((x) => x.alert_group_id);
            r.policy = r.channel_policy ? JSON.parse(r.channel_policy) : {};
        }
        res.render("sensors/rules", { title: req.sensor.name, sensor: req.sensor, location: req.location, unit: req.unit, rules: rules, groups: groups, bits: req.bits, permissions: permissions, navTrail: trail(req, "Alarm rules"), navSub: tabs(req, "Alarm rules") });
    }
    catch (err) { next(err); }
});

function ruleFromBody(req)
{
    const b = req.body;
    const kind = b.rule_kind === "no_data" ? "no_data" : "threshold";
    const row =
    {
        rule_kind: kind,
        severity: ["info", "warning", "alarm", "emergency"].includes(b.severity) ? b.severity : "alarm",
        is_enabled: b.is_enabled ? 1 : 0,
        use_default_group: b.use_default_group ? 1 : 0
    };
    if (kind === "threshold")
    {
        const t = Number(b.threshold);
        if (!Number.isFinite(t)) { throw new Error("Threshold must be a number."); }
        row.direction = b.direction === "lower" ? "lower" : "upper";
        row.threshold = fromDisplay(req, t);
        row.exceed_secs = Math.max(0, Number(b.exceed_minutes || 0) * 60);
        row.return_secs = Math.max(0, Number(b.return_minutes || 0) * 60);
        row.timeout_secs = null;
    }
    else
    {
        row.direction = null; row.threshold = null; row.exceed_secs = 0; row.return_secs = 0;
        row.timeout_secs = Math.max(60, Number(b.timeout_minutes || 30) * 60);
    }
    const policy = {};
    for (const tr of ["raise", "escalate", "de_escalate", "clear"])
    {
        policy[tr] = { email: !!b["p_" + tr + "_email"], sms: !!b["p_" + tr + "_sms"] };
    }
    row.channel_policy = JSON.stringify(policy);
    return row;
}

async function saveGroups(ruleId, groupIds, trx)
{
    await trx(T("alarm_rule_alert_groups")).where({ alarm_rule_id: ruleId }).del();
    for (const g of groupIds) { await trx(T("alarm_rule_alert_groups")).insert({ alarm_rule_id: ruleId, alert_group_id: Number(g) }); }
}

router.post("/:uid/rules", loadSensor, need("manage_alarms"), async (req, res, next) =>
{
    const back = "/sensors/" + req.params.uid + "/rules";
    try
    {
        const row = ruleFromBody(req);
        const groupIds = [].concat(req.body.groups || []);
        await knex.transaction(async (trx) =>
        {
            const r = await trx(T("alarm_rules")).insert(Object.assign(row, { sensor_id: req.sensor.id, created_epoch: nowEpoch() })).returning("id");
            const id = insertId(r);
            await saveGroups(id, groupIds, trx);
            await audit(trx, { entityType: "sensor", entityUid: req.sensor.uid, entityName: req.sensor.name, field: "alarm_rule_added", newValue: JSON.stringify(row), actorType: "user", actorId: req.user.id, actorName: req.user.username });
        });
        await activity.log(req, "alarm_rule_created", { entity_type: "sensor", entity_uid: req.sensor.uid });
        req.flash("success", "Rule added.");
    }
    catch (err) { req.flash("danger", err.message); }
    res.redirect(back);
});

router.post("/:uid/rules/:ruleUid", loadSensor, need("manage_alarms"), async (req, res, next) =>
{
    const back = "/sensors/" + req.params.uid + "/rules";
    try
    {
        const rule = await knex(T("alarm_rules")).where({ uid: req.params.ruleUid, sensor_id: req.sensor.id }).whereNull("delete_epoch").first();
        if (!rule) { req.flash("danger", "Rule not found."); return res.redirect(back); }
        if (req.body.action === "delete")
        {
            await knex.transaction(async (trx) =>
            {
                await trx(T("alarm_rules")).where({ id: rule.id }).update({ delete_epoch: nowEpoch() });
                await audit(trx, { entityType: "sensor", entityUid: req.sensor.uid, entityName: req.sensor.name, field: "alarm_rule_deleted", oldValue: rule.uid, actorType: "user", actorId: req.user.id, actorName: req.user.username });
            });
            req.flash("success", "Rule removed.");
            return res.redirect(back);
        }
        const row = ruleFromBody(req);
        if (row.rule_kind !== rule.rule_kind) { throw new Error("A rule's kind cannot change; add a new rule instead."); }
        await knex.transaction(async (trx) =>
        {
            // A threshold change restarts the clocks for that rule.
            if (rule.threshold !== row.threshold || rule.direction !== row.direction) { row.breach_since = null; row.return_since = null; }
            await trx(T("alarm_rules")).where({ id: rule.id }).update(row);
            await saveGroups(rule.id, [].concat(req.body.groups || []), trx);
            await audit(trx, { entityType: "sensor", entityUid: req.sensor.uid, entityName: req.sensor.name, field: "alarm_rule_" + rule.uid, oldValue: JSON.stringify({ direction: rule.direction, threshold: rule.threshold, severity: rule.severity }), newValue: JSON.stringify({ direction: row.direction, threshold: row.threshold, severity: row.severity }), actorType: "user", actorId: req.user.id, actorName: req.user.username });
        });
        req.flash("success", "Rule saved.");
    }
    catch (err) { req.flash("danger", err.message); }
    res.redirect(back);
});

// Description: NULL inherits the device type channel's text. Saving the default text unchanged,
// or nothing, stores NULL so later changes to the default still show.
router.post("/:uid/description", loadSensor, need("edit"), async (req, res, next) =>
{
    const back = "/sensors/" + req.params.uid;
    try
    {
        const fallback = channelDescription(req.sensor);
        let text = req.body.action === "default" ? "" : String(req.body.description || "").replace(/\r\n/g, "\n").trim().slice(0, 4000);
        if (fallback && text === fallback.trim()) { text = ""; }
        const value = text.length ? text : null;
        if (value !== req.sensor.description)
        {
            await knex.transaction(async (trx) =>
            {
                await trx(T("sensors")).where({ id: req.sensor.id }).update({ description: value });
                await audit(trx, { entityType: "sensor", entityUid: req.sensor.uid, entityName: req.sensor.name, field: "description", oldValue: req.sensor.description, newValue: value, actorType: "user", actorId: req.user.id, actorName: req.user.username });
            });
        }
        req.flash("success", value === null && fallback ? "Description reset to the device type default." : "Description saved.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

// Tags: own tags plus the device's, minus any this sensor excludes (services/tags.js combine).
router.get("/:uid/tags", loadSensor, async (req, res, next) =>
{
    try
    {
        const s = req.sensor;
        const own = await tagsSvc.tagNames("sensor", s.id);
        const excluded = await tagsSvc.excludedNames("sensor", s.id);
        const inherited = (await knex(T("taggings") + " as tg").join(T("tags") + " as t", "t.id", "tg.tag_id")
            .where({ "tg.entity_type": "device", "tg.entity_id": s.device_id }).select("t.id", "t.name").orderBy("t.name"))
            .map((t) => ({ id: t.id, name: t.name, excluded: excluded.includes(t.name) }));
        const all = await knex(T("tags")).where({ account_id: req.location.account_id }).orderBy("name");
        res.render("sensors/tags", {
            title: s.name, sensor: s, location: req.location, own: own, inherited: inherited, all: all,
            effective: tagsSvc.combine(own, inherited.map((t) => t.name), excluded),
            bits: req.bits, permissions: permissions, navTrail: trail(req, "Tags"), navSub: tabs(req, "Tags")
        });
    }
    catch (err) { next(err); }
});

router.post("/:uid/tags", loadSensor, need("edit"), async (req, res, next) =>
{
    const back = "/sensors/" + req.params.uid + "/tags";
    try
    {
        const s = req.sensor;
        const names = Array.from(new Set(String(req.body.tags || "").split(",").map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 40)));
        // Unchecked "Inherit" switches are the exclusions; only the device's current tags count.
        const keep = new Set([].concat(req.body.inherit || []).map(Number));
        const deviceTags = await knex(T("taggings") + " as tg").join(T("tags") + " as t", "t.id", "tg.tag_id")
            .where({ "tg.entity_type": "device", "tg.entity_id": s.device_id }).select("t.id", "t.name");
        const excluded = deviceTags.filter((t) => !keep.has(t.id));
        const before = await tagsSvc.effectiveForSensor(s);
        const after = tagsSvc.combine(names, deviceTags.map((t) => t.name), excluded.map((t) => t.name));
        await knex.transaction(async (trx) =>
        {
            await trx(T("taggings")).where({ entity_type: "sensor", entity_id: s.id }).del();
            for (const n of names)
            {
                const id = await tagsRepo.getOrCreate(req.location.account_id, n, false, trx);
                await tagsRepo.tag("sensor", s.id, id, trx);
            }
            await trx(T("tag_exclusions")).where({ entity_type: "sensor", entity_id: s.id }).del();
            for (const t of excluded) { await trx(T("tag_exclusions")).insert({ tag_id: t.id, entity_type: "sensor", entity_id: s.id }); }
            if (before.slice().sort().join(",") !== after.slice().sort().join(","))
            {
                await audit(trx, { entityType: "sensor", entityUid: s.uid, entityName: s.name, field: "tags", oldValue: before.join(", "), newValue: after.join(", "), actorType: "user", actorId: req.user.id, actorName: req.user.username });
            }
        });
        req.flash("success", "Tags saved.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

router.get("/:uid/settings", loadSensor, need("edit"), async (req, res, next) =>
{
    try
    {
        const units = [req.metric.canonical].concat(Object.keys(req.metric.units));
        res.render("sensors/settings", { title: req.sensor.name, sensor: req.sensor, location: req.location, unit: req.unit, units: units, metric: req.metric, bits: req.bits, permissions: permissions, navTrail: trail(req, "Settings"), navSub: tabs(req, "Settings") });
    }
    catch (err) { next(err); }
});

router.post("/:uid/settings", loadSensor, need("edit"), body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    const back = "/sensors/" + req.params.uid + "/settings";
    try
    {
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect(back); }
        const unit = req.body.display_unit === "" ? null : req.body.display_unit;
        if (unit && unit !== req.metric.canonical && !req.metric.units[unit]) { req.flash("danger", "That unit does not apply to " + req.metric.label + "."); return res.redirect(back); }
        const patch =
        {
            name: req.body.name.trim(),
            display_unit: unit,
            display_precision: req.body.display_precision === "" ? null : Math.max(0, Math.min(6, Number(req.body.display_precision))),
            retention_days: req.body.retention_days === "" ? null : (req.body.retention_days === "forever" ? -1 : Math.max(1, Number(req.body.retention_days))),
            is_enabled: req.body.is_enabled ? 1 : 0
        };
        await knex.transaction(async (trx) =>
        {
            for (const [f, v] of Object.entries(patch))
            {
                if (String(req.sensor[f]) !== String(v)) { await audit(trx, { entityType: "sensor", entityUid: req.sensor.uid, entityName: req.sensor.name, field: f, oldValue: req.sensor[f], newValue: v, actorType: "user", actorId: req.user.id, actorName: req.user.username }); }
            }
            await trx(T("sensors")).where({ id: req.sensor.id }).update(patch);
        });
        display.invalidate();
        req.flash("success", "Sensor settings saved.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

// Hide or unhide one sensor (DECISIONS "Sensor delete and hide"). Hidden: readings still stored,
// no alarms (active ones cleared here), left out of the device's sensor list and chart pickers.
// from=device returns to the device page's hidden list (its Unhide button), otherwise Settings.
router.post("/:uid/hide", loadSensor, need("edit"), async (req, res, next) =>
{
    const hide = req.body.action !== "unhide";
    const back = req.body.from === "device"
        ? "/devices/" + String(req.sensor.device_uid).toLowerCase() + "?hidden=1"
        : "/sensors/" + String(req.sensor.uid).toLowerCase() + "/settings";
    try
    {
        if (Boolean(req.sensor.is_hidden) === hide) { return res.redirect(back); }
        const now = nowEpoch();
        if (hide)
        {
            const engine = require("../services/alarms/engine");
            const active = await knex(T("alarms")).where({ sensor_id: req.sensor.id }).whereNull("cleared_epoch");
            for (const a of active)
            {
                await engine.clear(a, now, "disarmed", { type: "user", id: req.user.id }, "sensor hidden");
            }
        }
        await knex.transaction(async (trx) =>
        {
            await trx(T("sensors")).where({ id: req.sensor.id }).update({ is_hidden: hide ? 1 : 0 });
            await audit(trx, { entityType: "sensor", entityUid: req.sensor.uid, entityName: req.sensor.name, field: "is_hidden", oldValue: req.sensor.is_hidden ? 1 : 0, newValue: hide ? 1 : 0, actorType: "user", actorId: req.user.id, actorName: req.user.username });
        });
        display.invalidate();
        await activity.log(req, hide ? "sensor_hidden" : "sensor_unhidden", { entity_type: "sensor", entity_uid: req.sensor.uid });
        req.flash("success", "Sensor " + req.sensor.name + (hide ? " hidden. It still logs readings; alarms are off." : " is visible again. Alarms resume with its next reading."));
        res.redirect(back);
    }
    catch (err) { next(err); }
});

// Delete one sensor (soft delete, readings purged after retention), as device delete does for all
// of a device's sensors: active alarms cleared, alarm rules and the sensor marked deleted, audited.
// If the device still reports the channel, ingest creates a new sensor (new uid, no history) with
// its next value (DECISIONS "Sensor delete and hide"); that is how test and startup data is cleared.
router.post("/:uid/delete", loadSensor, need("delete"), async (req, res, next) =>
{
    const back = "/devices/" + String(req.sensor.device_uid).toLowerCase();
    try
    {
        const now = nowEpoch();
        const engine = require("../services/alarms/engine");
        const active = await knex(T("alarms")).where({ sensor_id: req.sensor.id }).whereNull("cleared_epoch");
        for (const a of active)
        {
            await engine.clear(a, now, "archived", { type: "user", id: req.user.id }, "sensor deleted");
        }
        await knex.transaction(async (trx) =>
        {
            await trx(T("alarm_rules")).where({ sensor_id: req.sensor.id }).whereNull("delete_epoch").update({ delete_epoch: now });
            await trx(T("sensors")).where({ id: req.sensor.id }).whereNull("delete_epoch").update({ delete_epoch: now });
            await audit(trx, { entityType: "sensor", entityUid: req.sensor.uid, entityName: req.sensor.name, field: "deleted", actorType: "user", actorId: req.user.id, actorName: req.user.username });
        });
        display.invalidate();
        await activity.log(req, "sensor_deleted", { entity_type: "sensor", entity_uid: req.sensor.uid });
        req.flash("success", "Sensor " + req.sensor.name + " deleted.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

module.exports = router;
