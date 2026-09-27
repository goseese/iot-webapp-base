// Analytics: saved charts (one JSON definition each) and dashboards (ordered tabs of charts or
// tag queries), with private / account_view / account_edit visibility (architecture 9).
const express = require("express");
const { notFoundError } = require("../middleware/errors");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch, insertId } = require("../db/knex");
const { requireLogin } = require("../middleware/auth");
const grants = require("../services/grants");
const metrics = require("../metrics");
const display = require("../services/display");
const sensorsExt = require("../db/repos/sensorsExt");
const { useAccount } = require("../middleware/account");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../middleware/account").uidParam);
router.use(requireLogin);

// The list and create pages belong to an account: mounted under /account/<uid>/analytics. At the bare
// /analytics mount there is none, so send the user to the account list.
function needAccount(req, res, next)
{
    if (req.account) { return next(); }
    if (req.method === "GET") { return res.redirect("/account"); }
    next(notFoundError());
}

const visibility = require("../services/visibility");
const canSee = (row, req) => visibility.canSee(row, req.user);
const canEdit = (row, req) => visibility.canEdit(row, req.user);

// The sensors a chart form offers: visible ones, minus hidden sensors (DECISIONS "Sensor delete and
// hide"), except any the chart already has (listed as hidden), so saving never drops one silently.
async function pickerSensors(req, def)
{
    const chosen = new Set(((def && def.sensors) || []).map((u) => String(u).toLowerCase()));
    return (await visibleSensors(req)).filter((s) => !s.is_hidden || chosen.has(String(s.uid).toLowerCase()));
}

async function visibleSensors(req)
{
    const locations = await grants.visibleLocations(req);
    if (!locations.length) { return []; }
    return knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id")
        .whereIn("l.id", locations.map((l) => l.id)).whereNull("s.delete_epoch").whereNull("d.delete_epoch")
        .select("s.uid", "s.name", "s.metric", "s.is_hidden", "s.display_unit", "d.name as device_name", "l.name as location_name", "l.id as location_id", "l.account_id").orderBy(["l.name", "d.name", "s.sort_order"]);
}

router.get("/", needAccount, async (req, res, next) =>
{
    try
    {
        const charts = (await knex(T("charts")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name")).filter((c) => canSee(c, req));
        const dashboards = (await knex(T("dashboards")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name")).filter((d) => canSee(d, req));
        res.render("analytics/index", { title: "Analytics", charts: charts, dashboards: dashboards });
    }
    catch (err) { next(err); }
});

// ---- charts
router.get("/charts/new", needAccount, async (req, res, next) =>
{
    try { res.render("analytics/chart-edit", { title: "New chart", chart: null, def: { sensors: [], range: "24h" }, sensors: await pickerSensors(req, null), navTrail: [{ label: "Analytics", path: req.acctBase + "/analytics" }, { label: "New chart", path: "", isCurrent: true }] }); }
    catch (err) { next(err); }
});

async function loadChart(req, res, next)
{
    try
    {
        const c = await knex(T("charts")).where({ uid: req.params.uid }).whereNull("delete_epoch").first();
        if (!c || !canSee(c, req) || !useAccount(req, c.account_id)) { return next(notFoundError()); }
        req.chart = c; req.def = JSON.parse(c.definition_json);
        next();
    }
    catch (err) { next(err); }
}

router.get("/charts/:uid", loadChart, async (req, res, next) =>
{
    try
    {
        res.render("analytics/chart-view", { title: req.chart.name, chart: req.chart, def: req.def, canEdit: canEdit(req.chart, req), navTrail: [{ label: "Analytics", path: req.acctBase + "/analytics" }, { label: req.chart.name, path: "", isCurrent: true }] });
    }
    catch (err) { next(err); }
});

router.get("/charts/:uid/edit", loadChart, async (req, res, next) =>
{
    try
    {
        if (!canEdit(req.chart, req)) { return next(notFoundError()); }
        res.render("analytics/chart-edit", { title: "Edit " + req.chart.name, chart: req.chart, def: req.def, sensors: await pickerSensors(req, req.def), navTrail: [{ label: "Analytics", path: req.acctBase + "/analytics" }, { label: req.chart.name, path: "/analytics/charts/" + req.params.uid }, { label: "Edit", path: "", isCurrent: true }] });
    }
    catch (err) { next(err); }
});

// Multi-series data: each series in its own display unit; the client puts one axis per unit.
router.get("/charts/:uid/data", loadChart, async (req, res, next) =>
{
    try
    {
        const spans = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400 };
        const span = spans[req.query.range || req.def.range] || spans["24h"];
        const to = nowEpoch();
        const from = to - span;
        const allowed = await visibleSensors(req);
        const series = [];
        for (const uid of req.def.sensors || [])
        {
            const meta = allowed.find((s) => String(s.uid).toLowerCase() === String(uid).toLowerCase());
            // A hidden sensor stays in the chart's definition (so Unhide brings it back) but draws no series.
            if (!meta || meta.is_hidden) { continue; }
            const sensor = await knex(T("sensors")).where({ uid: uid }).first();
            const unit = await display.resolveUnit(sensor, { id: meta.location_id, account_id: meta.account_id });
            const rows = await sensorsExt.readings(sensor.id, from, to, 20000);
            const step = Math.max(1, Math.ceil(rows.length / 1500));
            const points = [];
            for (let i = 0; i < rows.length; i += step)
            {
                const chunk = rows.slice(i, i + step);
                const avg = chunk.reduce((a, r) => a + r.value, 0) / chunk.length;
                points.push([Number(chunk[chunk.length - 1].epoch) * 1000, Number(metrics.fromCanonical(sensor.metric, avg, unit).toFixed(4))]);
            }
            series.push({ name: meta.device_name + " / " + meta.name, unit: unit, precision: metrics.precision(sensor.metric, unit), points: points });
        }
        res.json({ from: from * 1000, to: to * 1000, series: series });
    }
    catch (err) { next(err); }
});

function defFromBody(req)
{
    const sensors = [].concat(req.body.sensors || []).map((s) => String(s).toLowerCase()).filter(require("../middleware/account").isUuid).slice(0, 12);
    return { sensors: sensors, range: ["1h", "6h", "24h", "7d", "30d", "90d"].includes(req.body.range) ? req.body.range : "24h" };
}

router.post("/charts", needAccount, body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect(req.acctBase + "/analytics/charts/new"); }
        const now = nowEpoch();
        const r = await knex(T("charts")).insert({ account_id: req.account.id, owner_user_id: req.user.id, name: req.body.name.trim(), visibility: visibility.normalize(req.body.visibility), definition_json: JSON.stringify(defFromBody(req)), created_epoch: now, updated_epoch: now }).returning("uid");
        const uid = insertId(r, "uid");
        req.flash("success", "Chart saved.");
        res.redirect("/analytics/charts/" + String(uid).toLowerCase());
    }
    catch (err) { next(err); }
});

router.post("/charts/:uid", loadChart, body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        if (!canEdit(req.chart, req)) { return next(notFoundError()); }
        if (req.body.action === "delete")
        {
            await knex(T("charts")).where({ id: req.chart.id }).update({ delete_epoch: nowEpoch() });
            req.flash("success", "Chart deleted.");
            return res.redirect(req.acctBase + "/analytics");
        }
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect("/analytics/charts/" + req.params.uid + "/edit"); }
        const patch = { name: req.body.name.trim(), definition_json: JSON.stringify(defFromBody(req)), updated_epoch: nowEpoch() };
        if (visibility.isOwner(req.chart, req.user)) { patch.visibility = visibility.normalize(req.body.visibility, req.chart.visibility); }
        await knex(T("charts")).where({ id: req.chart.id }).update(patch);
        req.flash("success", "Chart saved.");
        res.redirect("/analytics/charts/" + req.params.uid);
    }
    catch (err) { next(err); }
});

// ---- dashboards: tabs = [{ name, chart_uid }] or [{ name, tag_query }]
router.get("/dashboards/new", needAccount, async (req, res, next) =>
{
    try
    {
        const charts = (await knex(T("charts")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name")).filter((c) => canSee(c, req));
        res.render("analytics/dashboard-edit", { title: "New dashboard", dashboard: null, tabs: [], charts: charts, navTrail: [{ label: "Analytics", path: req.acctBase + "/analytics" }, { label: "New dashboard", path: "", isCurrent: true }] });
    }
    catch (err) { next(err); }
});

async function loadDashboard(req, res, next)
{
    try
    {
        const d = await knex(T("dashboards")).where({ uid: req.params.uid }).whereNull("delete_epoch").first();
        if (!d || !canSee(d, req) || !useAccount(req, d.account_id)) { return next(notFoundError()); }
        req.dashboard = d; req.tabs = JSON.parse(d.tabs);
        next();
    }
    catch (err) { next(err); }
}

router.get("/dashboards/:uid", loadDashboard, async (req, res, next) =>
{
    try
    {
        const tagsSvc = require("../services/tags");
        const tabIndex = Math.max(0, Math.min(req.tabs.length - 1, Number(req.query.tab) || 0));
        const tab = req.tabs[tabIndex] || null;
        let chart = null;
        let sensors = [];
        if (tab && tab.chart_uid && require("../middleware/account").isUuid(tab.chart_uid)) { chart = await knex(T("charts")).where({ uid: tab.chart_uid }).whereNull("delete_epoch").first(); if (chart && !canSee(chart, req)) { chart = null; } }
        if (tab && tab.tag_query)
        {
            const q = tagsSvc.parseQuery(tab.tag_query);
            for (const s of await visibleSensors(req))
            {
                if (s.is_hidden) { continue; }
                const row = await knex(T("sensors")).where({ uid: s.uid }).first();
                const effective = await tagsSvc.effectiveForSensor(row);
                if (tagsSvc.matches(q, effective, s.name))
                {
                    row.display = await display.format(row, row.last_value, { id: s.location_id, account_id: s.account_id });
                    row.device_name = s.device_name; row.location_name = s.location_name;
                    row.alarm = await knex(T("alarms")).where({ sensor_id: row.id }).whereNull("cleared_epoch").first();
                    sensors.push(row);
                }
            }
        }
        res.render("analytics/dashboard-view", { title: req.dashboard.name, dashboard: req.dashboard, tabs: req.tabs, tabIndex: tabIndex, tab: tab, chart: chart, sensors: sensors, canEdit: canEdit(req.dashboard, req), navTrail: [{ label: "Analytics", path: req.acctBase + "/analytics" }, { label: req.dashboard.name, path: "", isCurrent: true }] });
    }
    catch (err) { next(err); }
});

router.get("/dashboards/:uid/edit", loadDashboard, async (req, res, next) =>
{
    try
    {
        if (!canEdit(req.dashboard, req)) { return next(notFoundError()); }
        const charts = (await knex(T("charts")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name")).filter((c) => canSee(c, req));
        res.render("analytics/dashboard-edit", { title: "Edit " + req.dashboard.name, dashboard: req.dashboard, tabs: req.tabs, charts: charts, navTrail: [{ label: "Analytics", path: req.acctBase + "/analytics" }, { label: req.dashboard.name, path: "/analytics/dashboards/" + req.params.uid }, { label: "Edit", path: "", isCurrent: true }] });
    }
    catch (err) { next(err); }
});

function tabsFromBody(req)
{
    const tabs = [];
    for (let i = 0; i < 12; i++)
    {
        const name = (req.body["tab_" + i + "_name"] || "").trim();
        if (!name) { continue; }
        const kind = req.body["tab_" + i + "_kind"];
        if (kind === "chart" && require("../middleware/account").isUuid(String(req.body["tab_" + i + "_chart"] || ""))) { tabs.push({ name: name, chart_uid: String(req.body["tab_" + i + "_chart"]).toLowerCase() }); }
        else if (kind === "tags") { tabs.push({ name: name, tag_query: { any: (req.body["tab_" + i + "_any"] || "").split(",").map((s) => s.trim()).filter(Boolean), all: [], none: [], text: (req.body["tab_" + i + "_text"] || "").trim() } }); }
    }
    return tabs;
}

router.post("/dashboards", needAccount, body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect(req.acctBase + "/analytics/dashboards/new"); }
        const now = nowEpoch();
        const r = await knex(T("dashboards")).insert({ account_id: req.account.id, owner_user_id: req.user.id, name: req.body.name.trim(), visibility: visibility.normalize(req.body.visibility), tabs: JSON.stringify(tabsFromBody(req)), created_epoch: now, updated_epoch: now }).returning("uid");
        const uid = insertId(r, "uid");
        req.flash("success", "Dashboard saved.");
        res.redirect("/analytics/dashboards/" + String(uid).toLowerCase());
    }
    catch (err) { next(err); }
});

router.post("/dashboards/:uid", loadDashboard, body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        if (!canEdit(req.dashboard, req)) { return next(notFoundError()); }
        if (req.body.action === "delete")
        {
            await knex(T("dashboards")).where({ id: req.dashboard.id }).update({ delete_epoch: nowEpoch() });
            req.flash("success", "Dashboard deleted.");
            return res.redirect(req.acctBase + "/analytics");
        }
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect("/analytics/dashboards/" + req.params.uid + "/edit"); }
        const patch = { name: req.body.name.trim(), tabs: JSON.stringify(tabsFromBody(req)), updated_epoch: nowEpoch() };
        if (visibility.isOwner(req.dashboard, req.user)) { patch.visibility = visibility.normalize(req.body.visibility, req.dashboard.visibility); }
        await knex(T("dashboards")).where({ id: req.dashboard.id }).update(patch);
        req.flash("success", "Dashboard saved.");
        res.redirect("/analytics/dashboards/" + req.params.uid);
    }
    catch (err) { next(err); }
});

module.exports = router;
