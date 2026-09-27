const express = require("express");
const { notFoundError } = require("../middleware/errors");
const path = require("path");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch } = require("../db/knex");
const { requireLogin } = require("../middleware/auth");
const permissions = require("../permissions");
const grants = require("../services/grants");
const reportTypes = require("../reportTypes");
const reportsSvc = require("../services/reports");
const activity = require("../services/activity");
const { useAccount } = require("../middleware/account");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../middleware/account").uidParam);
router.param("runId", require("../middleware/account").intParam);
router.use(requireLogin);

// The list and create pages belong to an account: mounted under /account/<uid>/reports. At the bare
// /reports mount there is none, so send the user to the account list.
function needAccount(req, res, next)
{
    if (req.account) { return next(); }
    if (req.method === "GET") { return res.redirect("/account"); }
    next(notFoundError());
}

async function canManage(req) { return req.account ? permissions.has(await grants.effectiveAtAccount(req, req.account.id), permissions.byName.manage_reports) : false; }
const visibility = require("../services/visibility");
const canSee = (r, req) => visibility.canSee(r, req.user);

router.get("/", needAccount, async (req, res, next) =>
{
    try
    {
        const reports = (await knex(T("reports")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name")).filter((r) => canSee(r, req));
        for (const r of reports) { r.type = reportTypes.all[r.report_type]; r.schedule = r.schedule_json ? JSON.parse(r.schedule_json) : null; }
        res.render("reports/index", { title: "Reports", reports: reports, canManage: await canManage(req) });
    }
    catch (err) { next(err); }
});

async function formData(req)
{
    const locations = await knex(T("locations")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name");
    const users = await knex(T("grants") + " as g").join(T("users") + " as u", "u.id", "g.grantee_id").where({ "g.grantee_type": "user", "g.scope_type": "account", "g.scope_id": req.account.id }).whereNull("u.delete_epoch").select("u.id", "u.username", "u.display_name");
    const contacts = await knex(T("contacts")).where({ account_id: req.account.id }).whereNull("delete_epoch").whereNotNull("email").orderBy("name");
    return { locations: locations, users: users, contacts: contacts, types: Object.values(reportTypes.all) };
}

router.get("/new", needAccount, async (req, res, next) =>
{
    try
    {
        if (!(await canManage(req))) { return next(notFoundError()); }
        res.render("reports/edit", Object.assign({ title: "New report", report: null, query: { windowDays: 1 }, schedule: null, recipients: [], navTrail: [{ label: "Reports", path: req.acctBase + "/reports" }, { label: "New", path: "", isCurrent: true }] }, await formData(req)));
    }
    catch (err) { next(err); }
});

async function loadReport(req, res, next)
{
    try
    {
        const r = await knex(T("reports")).where({ uid: req.params.uid }).whereNull("delete_epoch").first();
        if (!r || !canSee(r, req) || !useAccount(req, r.account_id)) { return next(notFoundError()); }
        req.report = r;
        next();
    }
    catch (err) { next(err); }
}

router.get("/:uid", loadReport, async (req, res, next) =>
{
    try
    {
        const runs = await knex(T("report_runs")).where({ report_id: req.report.id }).orderBy("epoch", "desc").limit(30);
        res.render("reports/show", { title: req.report.name, report: req.report, type: reportTypes.all[req.report.report_type], runs: runs, canManage: await canManage(req), navTrail: [{ label: "Reports", path: req.acctBase + "/reports" }, { label: req.report.name, path: "", isCurrent: true }] });
    }
    catch (err) { next(err); }
});

router.get("/:uid/edit", loadReport, async (req, res, next) =>
{
    try
    {
        if (!(await canManage(req))) { return next(notFoundError()); }
        const recipients = await knex(T("report_recipients")).where({ report_id: req.report.id });
        res.render("reports/edit", Object.assign({ title: "Edit " + req.report.name, report: req.report, query: JSON.parse(req.report.query_json), schedule: req.report.schedule_json ? JSON.parse(req.report.schedule_json) : null, recipients: recipients.map((r) => r.recipient_type + ":" + r.recipient_id), navTrail: [{ label: "Reports", path: req.acctBase + "/reports" }, { label: req.report.name, path: "/reports/" + req.params.uid }, { label: "Edit", path: "", isCurrent: true }] }, await formData(req)));
    }
    catch (err) { next(err); }
});

function fromBody(req)
{
    const b = req.body;
    const query = { locationId: b.location_id ? Number(b.location_id) : null, windowDays: Math.max(1, Math.min(90, Number(b.window_days) || 1)), tagQuery: (b.tq_any || b.tq_text) ? { any: (b.tq_any || "").split(",").map((s) => s.trim()).filter(Boolean), all: [], none: [], text: (b.tq_text || "").trim() } : null };
    let schedule = null;
    if (b.schedule_mode === "daily" || b.schedule_mode === "weekly")
    {
        schedule = { mode: b.schedule_mode, time: /^\d{2}:\d{2}$/.test(b.schedule_time || "") ? b.schedule_time : "07:00", days: [].concat(b.schedule_days || []).map(Number) };
    }
    return {
        name: b.name.trim(), report_type: reportTypes.all[b.report_type] ? b.report_type : "readings_summary", location_id: query.locationId, query_json: JSON.stringify(query),
        schedule_json: schedule ? JSON.stringify(schedule) : null, output_kind: b.output_kind === "csv" ? "csv" : "html",
        visibility: visibility.normalize(b.visibility), is_enabled: b.is_enabled ? 1 : 0
    };
}

async function saveRecipients(reportId, list, trx)
{
    await trx(T("report_recipients")).where({ report_id: reportId }).del();
    for (const item of [].concat(list || [])) { const [type, id] = String(item).split(":"); if ((type === "user" || type === "contact") && Number(id)) { await trx(T("report_recipients")).insert({ report_id: reportId, recipient_type: type, recipient_id: Number(id) }); } }
}

router.post("/", needAccount, body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        if (!(await canManage(req))) { return next(notFoundError()); }
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect(req.acctBase + "/reports/new"); }
        const row = Object.assign(fromBody(req), { account_id: req.account.id, owner_user_id: req.user.id, created_epoch: nowEpoch() });
        let uid = null;
        await knex.transaction(async (trx) =>
        {
            const r = await trx(T("reports")).insert(row).returning(["id", "uid"]);
            await saveRecipients(r[0].id, req.body.recipients, trx);
            uid = r[0].uid;
        });
        req.flash("success", "Report saved.");
        res.redirect("/reports/" + String(uid).toLowerCase());
    }
    catch (err) { next(err); }
});

router.post("/:uid", loadReport, body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        if (!(await canManage(req))) { return next(notFoundError()); }
        if (req.body.action === "run")
        {
            const r = await reportsSvc.run(req.report, "manual", req.user);
            await activity.log(req, "report_run", { entity_type: "report", entity_uid: req.report.uid, outcome: r.ok ? "ok" : "failed", detail: r.ok ? r.rows + " rows" : r.error });
            req.flash(r.ok ? "success" : "danger", r.ok ? "Report ran: " + r.rows + " rows." : "Report failed: " + r.error);
            return res.redirect("/reports/" + req.params.uid);
        }
        if (req.body.action === "delete")
        {
            await knex(T("reports")).where({ id: req.report.id }).update({ delete_epoch: nowEpoch() });
            req.flash("success", "Report deleted.");
            return res.redirect(req.acctBase + "/reports");
        }
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect("/reports/" + req.params.uid + "/edit"); }
        await knex.transaction(async (trx) =>
        {
            await trx(T("reports")).where({ id: req.report.id }).update(fromBody(req));
            await saveRecipients(req.report.id, req.body.recipients, trx);
        });
        req.flash("success", "Report saved.");
        res.redirect("/reports/" + req.params.uid);
    }
    catch (err) { next(err); }
});

router.get("/:uid/runs/:runId", loadReport, async (req, res, next) =>
{
    try
    {
        const run = await knex(T("report_runs")).where({ id: Number(req.params.runId), report_id: req.report.id }).first();
        if (!run || !run.file_path) { return next(notFoundError()); }
        res.download(path.join(reportsSvc.DIR, path.basename(run.file_path)), req.report.name.replace(/[^\w.-]+/g, "_") + "." + (req.report.output_kind === "csv" ? "csv" : "html"));
    }
    catch (err) { next(err); }
});

module.exports = router;
