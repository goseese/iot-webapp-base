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
const title = require("../services/alarms/title");
const ruleLog = require("../services/alarms/ruleLog");
const ruleHistory = require("../services/alarms/ruleHistory");
const chartEmail = require("../services/chartEmail");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../middleware/account").uidParam);
router.param("ruleUid", require("../middleware/account").uidParam);
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
    return [{ label: "Overview", path: base }, { label: "Alarm rules", path: base + "/rules" }, { label: "Tags", path: base + "/tags" }, { label: "API", path: base + "/api" }, { label: "Settings", path: base + "/settings" }].map((t) => ({ label: t.label, path: t.path, active: t.label === current }));
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
// A canonical threshold as text in the page's unit, at the unit's precision, for the change history.
function thresholdText(req, v) { return metrics.fromCanonical(req.sensor.metric, Number(v), req.unit).toFixed(metrics.precision(req.sensor.metric, req.unit)) + (req.unit ? " " + req.unit : ""); }

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

// Chart data in display units: raw readings, never averaged, sent in chunks newest first.
// The first request covers the range up to now. While more is true, the chart asks again
// with the same from and to = next_to (epoch seconds) for the next older chunk.
const CHART_CHUNK = 10000;
const CHART_MAX_SPAN = 366 * 86400;

// Same check as epochOf() in routes/api.js: whole epoch seconds, anything else is ignored.
function epochParam(v)
{
    if (v === undefined || v === null || v === "") { return null; }
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 && n < 1e11 ? n : null;
}

router.get("/:uid/data", loadSensor, async (req, res, next) =>
{
    try
    {
        const spans = { "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
        const span = spans[req.query.range] || spans["24h"];
        const now = nowEpoch();
        let to = epochParam(req.query.to);
        let from = epochParam(req.query.from);
        if (to === null || to > now) { to = now; }
        if (from === null || from > to) { from = to - span; }
        // A window is at most a year (Jeff, Oct 2026; iot-chart-tools.js MAX_SPAN_MS).
        if (to - from > CHART_MAX_SPAN) { from = to - CHART_MAX_SPAN; }

        // One row past the chunk tells us there is more. The oldest second in the chunk may be
        // split across two requests, so it is left whole for the next one (the API's next_from
        // rule, reversed). A chunk that is all one second keeps it and steps one second back.
        const rows = await sensorsExt.readings(req.sensor.id, from, to, CHART_CHUNK + 1);
        let page = rows;
        let more = false;
        let nextTo = null;
        if (rows.length > CHART_CHUNK)
        {
            const cut = Number(rows[0].epoch);
            more = true;
            page = rows.slice(1).filter((r) => Number(r.epoch) > cut);
            if (page.length) { nextTo = cut; }
            else { page = rows.slice(1); nextTo = cut - 1; }
        }

        const points = page.map((r) => [Number(r.epoch) * 1000, Number(toDisplay(req, r.value).toFixed(4))]);
        const rules = (await sensorsExt.rules(req.sensor.id)).filter((r) => r.rule_kind === "threshold" && r.is_enabled).map((r) => ({ direction: r.direction, severity: r.severity, value: toDisplay(req, r.threshold) }));
        res.json({ unit: req.unit, timezone: req.location.iana_timezone, points: points, rules: rules, from: from * 1000, to: to * 1000, more: more, next_to: nextTo });
    }
    catch (err) { next(err); }
});

// Share > Email... > Send from the site (services/chartEmail.js): the readings in the posted window
// and the chart image the browser drew. View is enough: the same image and readings download.
router.post("/:uid/email", loadSensor, chartEmail.upload, async (req, res, next) =>
{
    try
    {
        const s = req.sensor;
        const uid = String(s.uid).toLowerCase();
        const r = await chartEmail.send(req,
        {
            accountId: req.location.account_id, source: "sensor", sensorId: s.id, chartId: null, uid: uid,
            title: s.name + " on " + s.device_name, tz: chartEmail.tzOf(req.location.iana_timezone),
            series: [{ id: s.id, name: s.name, unit: req.unit, toDisplay: (v) => toDisplay(req, v) }],
            path: "/sensors/" + uid, from: epochParam(req.body.window_from), to: epochParam(req.body.window_to), image: req.file ? req.file.buffer : null
        });
        res.status(r.status).json(r.body);
    }
    catch (err) { next(err); }
});

router.get("/:uid/rules", loadSensor, async (req, res, next) =>
{
    try
    {
        const rules = await sensorsExt.rules(req.sensor.id);
        const groups = await knex(T("alert_groups")).where({ account_id: req.location.account_id }).whereNull("delete_epoch").orderBy("name");
        // What a rule's title inherits when blank: the same for every rule on this sensor.
        const inh = await title.inherited("rule", { sensor: req.sensor.alarm_title, device: req.sensor.device_alarm_title, location_id: req.location.id, account_id: req.location.account_id });
        for (const r of rules)
        {
            r.thresholdDisplay = toDisplay(req, r.threshold);
            r.groups = (await knex(T("alarm_rule_alert_groups")).where({ alarm_rule_id: r.id })).map((x) => x.alert_group_id);
            r.policy = r.channel_policy ? JSON.parse(r.channel_policy) : {};
            r.titleField = title.field({ id: "title_" + r.uid, value: r.alarm_title, inherited: inh, sample: titleSample(req, r), size: "sm" });
        }
        const newTitleField = title.field({ id: "title_new", value: "", inherited: inh, sample: titleSample(req, null), size: "sm" });

        // Change history (ruleHistory.js): one query for every rule on this sensor, live and
        // removed (the 50 most recently removed), newest first; thresholds in this page's unit.
        const removed = await knex(T("alarm_rules")).where({ sensor_id: req.sensor.id }).whereNotNull("delete_epoch").orderBy("delete_epoch", "desc").limit(50);
        const history = ruleHistory.byRule(await ruleHistory.rowsFor(rules.concat(removed).map((r) => r.uid)), { threshold: (v) => thresholdText(req, v) });
        for (const r of rules) { r.history = history.get(String(r.uid).toLowerCase()) || []; }
        for (const r of removed)
        {
            r.history = history.get(String(r.uid).toLowerCase()) || [];
            const del = r.history.find((l) => l.field === "deleted");
            r.summary = del ? del.before : ruleHistory.summary(ruleLog.snapshotOf(r, []), { threshold: (v) => thresholdText(req, v) });
            r.removedBy = del ? del.who : "";
        }
        res.render("sensors/rules", { title: req.sensor.name, sensor: req.sensor, location: req.location, unit: req.unit, rules: rules, removed: removed, groups: groups, newTitleField: newTitleField, bits: req.bits, permissions: permissions, navTrail: trail(req, "Alarm rules"), navSub: tabs(req, "Alarm rules") });
    }
    catch (err) { next(err); }
});

// Preview values for a rule's title field: this sensor's real names, and for an existing rule
// its own direction, limit and delays. The limit stands in for the readings.
function titleSample(req, r)
{
    const names = { location_name: req.location.name, device_name: req.sensor.device_name, sensor_name: req.sensor.name };
    if (!r) { return names; }
    const limit = r.rule_kind === "threshold" && r.thresholdDisplay !== null && r.thresholdDisplay !== undefined ? (r.thresholdDisplay + " " + (req.unit || "")).trim() : "";
    const ctx = Object.assign({ severity: r.severity, direction: r.rule_kind === "no_data" ? "no_data" : r.direction }, names);
    const v = title.tokens(ctx, r, { alarm_limit: limit, exceed_value: limit, return_value: limit });
    // Tokens the page cannot know (account, site) keep their SAMPLE values.
    return Object.fromEntries(Object.entries(v).filter((e) => e[1] !== undefined));
}

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
    row.alarm_title = title.clean(b.alarm_title);
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
        let ruleUid = null;
        await knex.transaction(async (trx) =>
        {
            const r = await trx(T("alarm_rules")).insert(Object.assign(row, { sensor_id: req.sensor.id, created_epoch: nowEpoch() })).returning("id");
            const id = insertId(r);
            await saveGroups(id, groupIds, trx);
            ruleUid = await ruleLog.created(trx, id, req.sensor.name, ruleLog.actorOf(req.user));
        });
        await activity.log(req, "alarm_rule_created", { entity_type: "alarm_rule", entity_uid: ruleUid, detail: "sensor " + req.sensor.name });
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
                await ruleLog.deleted(trx, rule.id, req.sensor.name, ruleLog.actorOf(req.user));
            });
            await activity.log(req, "alarm_rule_deleted", { entity_type: "alarm_rule", entity_uid: String(rule.uid).toLowerCase(), detail: "sensor " + req.sensor.name });
            req.flash("success", "Rule removed.");
            return res.redirect(back);
        }
        const row = ruleFromBody(req);
        if (row.rule_kind !== rule.rule_kind) { throw new Error("A rule's kind cannot change; add a new rule instead."); }
        // The form shows the threshold converted to the display unit, and converting back is not
        // always exact (26.0 C shows as 78.80000000000001 F). A threshold field left as shown keeps
        // the stored value, so the save neither moves it, restarts its clocks nor logs a change.
        if (row.threshold !== null && rule.threshold !== null && String(req.body.threshold).trim() === String(toDisplay(req, rule.threshold))) { row.threshold = rule.threshold; }
        let changed = [];
        await knex.transaction(async (trx) =>
        {
            const before = await ruleLog.snapshot(trx, rule.id);
            // A threshold change restarts the clocks for that rule.
            if (rule.threshold !== row.threshold || rule.direction !== row.direction) { row.breach_since = null; row.return_since = null; }
            await trx(T("alarm_rules")).where({ id: rule.id }).update(row);
            await saveGroups(rule.id, [].concat(req.body.groups || []), trx);
            changed = await ruleLog.updated(trx, rule.id, before, req.sensor.name, ruleLog.actorOf(req.user));
        });
        if (changed.length)
        {
            await activity.log(req, "alarm_rule_updated", { entity_type: "alarm_rule", entity_uid: String(rule.uid).toLowerCase(), detail: "sensor " + req.sensor.name + ": " + changed.join(", ") });
        }
        req.flash("success", changed.length ? "Rule saved." : "No changes to save.");
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

// API tab (DECISIONS "API tabs"): ready to run API calls for this sensor, from services/apiDocs.js,
// with one change log call per live rule. The POST shows only when the device type takes API readings.
router.get("/:uid/api", loadSensor, async (req, res, next) =>
{
    try
    {
        const apiDocs = require("../services/apiDocs");
        const s = req.sensor;
        const type = deviceTypes.all[s.device_type_slug];
        const rules = await knex(T("alarm_rules")).where({ sensor_id: s.id }).whereNull("delete_epoch")
            .orderBy([{ column: "rule_kind", order: "asc" }, { column: "direction", order: "asc" }, { column: "threshold", order: "asc" }]).select("uid", "rule_kind", "direction", "severity");
        const page = { kind: "sensor", sensor: { uid: String(s.uid).toLowerCase(), channel: s.channel_id },
            device: { uid: String(s.device_uid).toLowerCase(), apiWrite: !!(type && type.apiWrite) },
            rules: rules.map((r) => ({ uid: String(r.uid).toLowerCase(), label: (r.rule_kind === "no_data" ? "no data" : r.direction) + ", " + r.severity })) };
        res.render("sensors/api", { title: s.name, api: apiDocs.pageCalls(apiDocs.site(), page), docsBase: req.acctBase + "/api/docs", navTrail: trail(req, "API"), navSub: tabs(req, "API") });
    }
    catch (err) { next(err); }
});

router.get("/:uid/settings", loadSensor, need("edit"), async (req, res, next) =>
{
    try
    {
        const units = [req.metric.canonical].concat(Object.keys(req.metric.units));
        const inh = await title.inherited("sensor", { device: req.sensor.device_alarm_title, location_id: req.location.id, account_id: req.location.account_id });
        const titleField = title.field({ value: req.sensor.alarm_title, inherited: inh, sample: titleSample(req, null) });
        res.render("sensors/settings", { title: req.sensor.name, sensor: req.sensor, location: req.location, unit: req.unit, units: units, metric: req.metric, titleField: titleField, bits: req.bits, permissions: permissions, navTrail: trail(req, "Settings"), navSub: tabs(req, "Settings") });
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
            is_enabled: req.body.is_enabled ? 1 : 0,
            alarm_title: title.clean(req.body.alarm_title)
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

// Where the device's sensor list is: its page, or its Sensors tab for a station type (controller pod).
function devicePage(sensor)
{
    const type = deviceTypes.all[sensor.device_type_slug];
    return "/devices/" + String(sensor.device_uid).toLowerCase() + (type && type.station ? "/sensors" : "");
}

// Hide or unhide one sensor (DECISIONS "Sensor delete and hide"). Hidden: readings still stored,
// no alarms (active ones cleared here), left out of the device's sensor list and chart pickers.
// from=device returns to the device page's hidden list (its Unhide button), otherwise Settings.
router.post("/:uid/hide", loadSensor, need("edit"), async (req, res, next) =>
{
    const hide = req.body.action !== "unhide";
    const back = req.body.from === "device"
        ? devicePage(req.sensor) + "?hidden=1"
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
    const back = devicePage(req.sensor);
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
            await ruleLog.deleteForSensors(trx, [req.sensor.id], ruleLog.actorOf(req.user), "sensor deleted", now);
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
