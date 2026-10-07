const express = require("express");
const { notFoundError } = require("../middleware/errors");
const { knex, T, nowEpoch } = require("../db/knex");
const { requireLogin } = require("../middleware/auth");
const permissions = require("../permissions");
const grants = require("../services/grants");
const alarmsRepo = require("../db/repos/alarms");
const actions = require("../services/alarms/actions");
const notify = require("../services/alarms/notify");
const activity = require("../services/activity");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../middleware/account").uidParam);
router.param("id", require("../middleware/account").intParam);
router.use(requireLogin);

function base(req)
{
    return knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id")
        .select("a.*", "s.name as sensor_name", "s.uid as sensor_uid", "d.name as device_name", "d.uid as device_uid", "l.name as location_name", "l.uid as location_uid", "l.iana_timezone", "l.id as location_id", "l.account_id");
}

// Alarm list pages are mounted under /locations/:uid/alarms; the location is req.scope there.
// The sidebar badge (count.json) names its location in ?location=<uid>, because nothing about the
// current location is kept in the session.
async function visibleIds(req)
{
    if (req.scope) { return [req.scope.id]; }
    const uid = String(req.query.location || "");
    if (!require("../middleware/account").GUID_RE.test(uid)) { return []; }
    const loc = await knex(T("locations")).where({ uid: uid }).whereNull("delete_epoch").first();
    return loc && await grants.can(req, loc, "view") ? [loc.id] : [];
}

const lists = express.Router();
lists.get("/", (req, res) => res.redirect(req.baseUrl + "/active"));

router.get("/count.json", async (req, res, next) =>
{
    try
    {
        const ids = await visibleIds(req);
        const n = ids.length ? Number((await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id").whereIn("d.location_id", ids).whereNull("a.cleared_epoch").whereNull("a.suppressed_by").count("a.id as n").first()).n) : 0;
        res.json({ count: n });
    }
    catch (err) { next(err); }
});

lists.get("/active", async (req, res, next) =>
{
    try
    {
        const ids = await visibleIds(req);
        const alarms = ids.length ? await base(req).whereIn("l.id", ids).whereNull("a.cleared_epoch").orderBy("a.raised_epoch", "desc") : [];
        const reasons = await knex(T("list_items") + " as i").join(T("lists") + " as l", "l.id", "i.list_id").where("l.slug", "ack_reasons").orderBy("i.sort_order").select("i.label");
        for (const a of alarms)
        {
            const b = await grants.effectiveAtLocation(req, { id: a.location_id, account_id: a.account_id });
            a.canAck = permissions.has(b, permissions.byName.ack_alarm);
            a.canClear = permissions.has(b, permissions.byName.clear_alarm);
        }
        res.render("alarms/active", { title: "Active alarms", alarms: alarms, reasons: reasons.map((r) => r.label), listBase: req.baseUrl });
    }
    catch (err) { next(err); }
});

lists.get("/history", async (req, res, next) =>
{
    try
    {
        const ids = await visibleIds(req);
        const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
        const alarms = ids.length ? await base(req).whereIn("l.id", ids).where("a.raised_epoch", ">=", nowEpoch() - days * 86400).orderBy("a.raised_epoch", "desc").limit(500) : [];
        res.render("alarms/history", { title: "Alarm history", alarms: alarms, days: days, listBase: req.baseUrl });
    }
    catch (err) { next(err); }
});

lists.get("/rules", async (req, res, next) =>
{
    try
    {
        const ids = await visibleIds(req);
        const rules = ids.length ? await knex(T("alarm_rules") + " as r").join(T("sensors") + " as s", "s.id", "r.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id")
            .whereIn("l.id", ids).whereNull("r.delete_epoch").whereNull("s.delete_epoch").whereNull("d.delete_epoch")
            .select("r.*", "s.name as sensor_name", "s.uid as sensor_uid", "s.metric", "s.display_unit", "d.name as device_name", "l.name as location_name").orderBy(["l.name", "d.name", "s.name"]) : [];
        const display = require("../services/display");
        const metrics = require("../metrics");
        for (const r of rules)
        {
            if (r.rule_kind === "threshold")
            {
                const unit = await display.resolveUnit({ metric: r.metric, display_unit: r.display_unit }, null);
                r.thresholdText = metrics.fromCanonical(r.metric, r.threshold, unit).toFixed(metrics.precision(r.metric, unit)) + " " + unit;
            }
        }
        res.render("alarms/rules", { title: "Alarm rules", rules: rules });
    }
    catch (err) { next(err); }
});

// API page (DECISIONS "API tabs"): ready to run alarm API calls for this location, and active alarms
// for its whole account, from services/apiDocs.js.
lists.get("/api", async (req, res, next) =>
{
    try
    {
        if (!req.scope) { return next(notFoundError()); }
        const apiDocs = require("../services/apiDocs");
        const page = { kind: "location-alarms", location: { uid: String(req.scope.uid).toLowerCase() }, account: req.account ? { uid: String(req.account.uid).toLowerCase() } : null };
        res.render("alarms/api", { title: "Alarm API", api: apiDocs.pageCalls(apiDocs.site(), page), docsBase: req.acctBase + "/api/docs" });
    }
    catch (err) { next(err); }
});

// "Why didn't I get it": every send decision for alarms in visible locations (architecture 8.6).
lists.get("/notifications", async (req, res, next) =>
{
    try
    {
        const ids = await visibleIds(req);
        const rows = ids.length ? await knex(T("notifications") + " as n").leftJoin(T("alarm_events") + " as e", "e.id", "n.alarm_event_id").leftJoin(T("alarms") + " as a", "a.id", "e.alarm_id")
            .leftJoin(T("sensors") + " as s", "s.id", "a.sensor_id").leftJoin(T("devices") + " as d", "d.id", "s.device_id").leftJoin(T("locations") + " as l", "l.id", "d.location_id")
            .where(function () { this.whereIn("l.id", ids); if (req.user.is_superadmin) { this.orWhereNull("n.alarm_event_id"); } })
            .modify(function (q) { if (req.query.kind) { q.where("n.kind", String(req.query.kind)); } if (req.query.outcome) { q.where("n.outcome", String(req.query.outcome)); } })
            .select("n.*", "e.event_kind", "a.uid as alarm_uid", "s.name as sensor_name", "d.name as device_name", "l.name as location_name", "l.iana_timezone").orderBy("n.epoch", "desc").limit(300) : [];
        for (const r of rows) { r.canOpen = !!req.user.is_superadmin || r.alarm_event_id !== null || (r.recipient_type === "user" && r.recipient_id === req.user.id); }
        res.render("alarms/notifications", { title: "Notification log", rows: rows, q: req.query });
    }
    catch (err) { next(err); }
});

// One notification with everything we know about it: message, driver, provider answer.
router.get("/notifications/:id.json", async (req, res, next) =>
{
    try
    {
        const n = await knex(T("notifications")).where({ id: Number(req.params.id) }).first();
        if (!n) { return res.status(404).json({ error: "Not found" }); }
        let allowed = !!req.user.is_superadmin || (n.recipient_type === "user" && n.recipient_id === req.user.id);
        let context = null;
        if (n.alarm_event_id)
        {
            const ev = await knex(T("alarm_events")).where({ id: n.alarm_event_id }).first();
            const ctx = ev ? await alarmsRepo.context(ev.alarm_id) : null;
            if (ctx)
            {
                const b = await grants.effectiveAtLocation(req, { id: ctx.location_id, account_id: ctx.account_id });
                if (permissions.has(b, permissions.byName.view)) { allowed = true; }
                context = { event: ev.event_kind, severity: ev.severity, alarm_uid: String(ctx.uid).toLowerCase(), sensor: ctx.sensor_name, device: ctx.device_name, location: ctx.location_name, timezone: ctx.iana_timezone };
            }
        }
        if (!allowed) { return res.status(404).json({ error: "Not found" }); }
        let raw = null;
        try { raw = n.provider_response ? JSON.parse(n.provider_response) : null; } catch (err) { raw = n.provider_response; }
        res.json({
            id: n.id, epoch: Number(n.epoch), kind: n.kind, channel: n.channel, provider: n.provider, outcome: n.outcome, reason: n.reason,
            to: n.address, recipient_type: n.recipient_type, from: n.sender, subject: n.subject, body: n.body, ladder: n.ladder_note,
            provider_message_id: n.provider_message_id, provider_response: raw, context: context
        });
    }
    catch (err) { next(err); }
});

async function loadAlarm(req, res, next)
{
    try
    {
        const a = await alarmsRepo.findByUid(req.params.uid);
        const ctx = a ? await alarmsRepo.context(a.id) : null;
        if (!ctx) { return next(notFoundError()); }
        const b = await grants.effectiveAtLocation(req, { id: ctx.location_id, account_id: ctx.account_id });
        if (!permissions.has(b, permissions.byName.view)) { return next(notFoundError()); }
        req.alarm = ctx; req.bits = b;
        require("../middleware/account").enterLocation(req, { id: ctx.location_id, account_id: ctx.account_id, uid: ctx.location_uid, name: ctx.location_name });
        next();
    }
    catch (err) { next(err); }
}

// The single alarm page: tabs Overview (cards, actions, timeline), Notifications (escalation and every
// send, newest first) and API (DECISIONS "API tabs").
function alarmTabs(a, current)
{
    const base = "/alarms/" + String(a.uid).toLowerCase();
    return [{ label: "Overview", path: base }, { label: "Notifications", path: base + "/notifications" }, { label: "API", path: base + "/api" }]
        .map((t) => ({ label: t.label, path: t.path, active: t.label === current }));
}

function alarmTrail(a)
{
    return [{ label: "Account", path: "/account" }, { label: a.location_name, path: "/locations/" + String(a.location_uid).toLowerCase() }, { label: "Alarms", path: "/locations/" + String(a.location_uid).toLowerCase() + "/alarms/active" }, { label: a.sensor_name, path: "/sensors/" + String(a.sensor_uid).toLowerCase() }, { label: "Alarm", path: "", isCurrent: true }];
}

function alarmPageTitle(a)
{
    return a.sensor_name + " " + a.direction.replace("_", " ");
}

router.get("/:uid", loadAlarm, async (req, res, next) =>
{
    try
    {
        const a = req.alarm;
        const events = await knex(T("alarm_events") + " as e").leftJoin(T("users") + " as u", function () { this.on("u.id", "e.actor_id").andOn("e.actor_type", knex.raw("?", ["user"])); })
            .where("e.alarm_id", a.id).select("e.*", "u.username as actor_username").orderBy("e.epoch");
        const reasons = await knex(T("list_items") + " as i").join(T("lists") + " as l", "l.id", "i.list_id").where("l.slug", "ack_reasons").orderBy("i.sort_order").select("i.label");
        res.render("alarms/show", {
            title: alarmPageTitle(a), alarm: a, value: notify.displayValue(a, a.trigger_value), events: events,
            canAck: permissions.has(req.bits, permissions.byName.ack_alarm), canClear: permissions.has(req.bits, permissions.byName.clear_alarm), reasons: reasons.map((r) => r.label),
            navTrail: alarmTrail(a), navSub: alarmTabs(a, "Overview")
        });
    }
    catch (err) { next(err); }
});

// Every notification this alarm sent or held back, newest first, with the event that caused it.
router.get("/:uid/notifications", loadAlarm, async (req, res, next) =>
{
    try
    {
        const a = req.alarm;
        const events = await knex(T("alarm_events")).where("alarm_id", a.id).select("id", "event_kind", "severity");
        const eventText = new Map(events.map((e) => [e.id, e.event_kind.replace("_", " ") + (e.severity ? " (" + e.severity + ")" : "")]));
        const notifications = events.length ? await knex(T("notifications")).whereIn("alarm_event_id", events.map((e) => e.id))
            .orderBy([{ column: "epoch", order: "desc" }, { column: "id", order: "desc" }]) : [];
        notifications.forEach((n) => { n.event_text = eventText.get(n.alarm_event_id) || ""; });
        const escalations = await knex(T("alarm_escalations") + " as x").join(T("alert_groups") + " as g", "g.id", "x.alert_group_id").where("x.alarm_id", a.id).select("x.*", "g.name");
        res.render("alarms/show-notifications", { title: alarmPageTitle(a), alarm: a, notifications: notifications, escalations: escalations, navTrail: alarmTrail(a), navSub: alarmTabs(a, "Notifications") });
    }
    catch (err) { next(err); }
});

router.get("/:uid/api", loadAlarm, async (req, res, next) =>
{
    try
    {
        const a = req.alarm;
        const apiDocs = require("../services/apiDocs");
        const api = apiDocs.pageCalls(apiDocs.site(), { kind: "alarm", alarm: { uid: String(a.uid).toLowerCase(), active: !a.cleared_epoch } });
        res.render("alarms/api", { title: alarmPageTitle(a), api: api, docsBase: req.acctBase + "/api/docs", navTrail: alarmTrail(a), navSub: alarmTabs(a, "API") });
    }
    catch (err) { next(err); }
});

// One alarm action. Form posts redirect; JSON requests (the bulk bar) get a JSON answer with
// the alarm's new state so the row can be updated in place.
router.post("/:uid/:action", loadAlarm, async (req, res, next) =>
{
    const wantsJson = req.is("application/json") || (req.get("accept") || "").includes("application/json");
    const reply = (status, ok, message, extra) =>
    {
        if (wantsJson) { return res.status(status).json(Object.assign({ ok: ok, message: message }, extra || {})); }
        req.flash(ok ? "success" : (status === 409 ? "warning" : "danger"), message);
        return res.redirect(req.body.back || "/alarms/" + req.params.uid);
    };
    try
    {
        const a = req.alarm;
        const comment = String(req.body.comment || "").trim().slice(0, 500);
        if (!comment) { return reply(400, false, "A comment is required."); }
        if (a.cleared_epoch) { return reply(409, false, "That alarm already cleared."); }
        const actor = { type: "user", id: req.user.id, name: req.user.username };
        let message = null;
        let state = null;
        if (req.params.action === "ack" && permissions.has(req.bits, permissions.byName.ack_alarm))
        {
            const minutes = Number(req.body.minutes) || 60;
            await actions.acknowledge(a, minutes, comment, actor);
            message = "Acknowledged."; state = { acked: true, ack_until_epoch: nowEpoch() + Math.max(5, Math.min(minutes, 1440)) * 60 };
        }
        else if (req.params.action === "ignore")
        {
            await actions.ignore(a, comment, actor);
            message = "Noted; you will not be notified again for this alarm."; state = { ignored: true };
        }
        else if (req.params.action === "clear" && permissions.has(req.bits, permissions.byName.clear_alarm))
        {
            await actions.clear(a, comment, actor);
            message = "Alarm cleared."; state = { cleared: true };
        }
        else { return reply(404, false, "You do not have permission for that action."); }
        await activity.log(req, "alarm_" + req.params.action, { entity_type: "alarm", entity_uid: a.uid, detail: comment });
        return reply(200, true, message, { state: state });
    }
    catch (err) { if (wantsJson) { return res.status(500).json({ ok: false, message: "Internal error", reference: req.id }); } next(err); }
});

module.exports = router;
module.exports.lists = lists;
