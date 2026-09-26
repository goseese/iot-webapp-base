// Alarm action links (architecture 8.7): opens without login, permissions checked at click time
// against current grants. Contacts get a read only view.
const express = require("express");
const tokens = require("../services/tokens");
const alarmsRepo = require("../db/repos/alarms");
const actions = require("../services/alarms/actions");
const notify = require("../services/alarms/notify");
const grants = require("../services/grants");
const permissions = require("../permissions");
const users = require("../db/repos/users");
const activity = require("../services/activity");
const { knex, T } = require("../db/knex");

const router = express.Router();
const AUTH = { layout: "layouts/auth" };

async function resolve(token)
{
    const row = await tokens.peek("alarm_action", token);
    if (!row) { return null; }
    const ctx = await alarmsRepo.context(row.subject_id);
    if (!ctx) { return null; }
    let actor = null;
    let bits = 0n;
    if (row.meta.recipientType === "user")
    {
        const u = await users.findById(row.meta.recipientId);
        if (u && u.delete_epoch === null)
        {
            actor = { type: "user", id: u.id, name: u.username, row: u };
            bits = await grants.effectiveAtLocation({ user: u }, { id: ctx.location_id, account_id: ctx.account_id });
        }
    }
    else
    {
        const c = await knex(T("contacts")).where({ id: row.meta.recipientId }).first();
        if (c) { actor = { type: "contact", id: c.id, name: c.name, row: c }; }
    }
    if (!actor) { return null; }
    const reasons = await knex(T("list_items") + " as i").join(T("lists") + " as l", "l.id", "i.list_id").where("l.slug", "ack_reasons").orderBy("i.sort_order").select("i.label");
    return {
        token: row, ctx: ctx, actor: actor,
        canAck: actor.type === "user" && permissions.has(bits, permissions.byName.ack_alarm),
        canClear: actor.type === "user" && permissions.has(bits, permissions.byName.clear_alarm),
        reasons: reasons.map((r) => r.label)
    };
}

function render(res, r, extra)
{
    res.render("auth/alarm-action", Object.assign({ title: "Alarm", r: r, tokenValue: r.tokenValue, value: r.ctx.trigger_value === null ? "" : notify.displayValue(r.ctx, r.ctx.trigger_value), error: null, done: null }, AUTH, extra || {}));
}

router.get("/a/:token", async (req, res, next) =>
{
    try
    {
        const r = await resolve(req.params.token);
        if (!r) { return res.status(410).render("auth/link-dead", Object.assign({ title: "This alarm link is no longer valid" }, AUTH)); }
        r.tokenValue = req.params.token;
        render(res, r);
    }
    catch (err) { next(err); }
});

router.post("/a/:token", async (req, res, next) =>
{
    try
    {
        const r = await resolve(req.params.token);
        if (!r) { return res.status(410).render("auth/link-dead", Object.assign({ title: "This alarm link is no longer valid" }, AUTH)); }
        r.tokenValue = req.params.token;
        const action = req.body.action;
        const comment = (req.body.comment || "").trim().slice(0, 500);
        if (!comment) { return render(res, r, { error: "A comment is required." }); }
        if (r.ctx.cleared_epoch) { return render(res, r, { error: "This alarm has already cleared." }); }

        let done = null;
        if (action === "acknowledge" && r.canAck)
        {
            await actions.acknowledge(r.ctx, Number(req.body.minutes) || 60, comment, r.actor);
            done = "Acknowledged for " + (Number(req.body.minutes) || 60) + " minutes. Notifications for this alarm pause until then.";
        }
        else if (action === "ignore" && r.actor.type === "user")
        {
            await actions.ignore(r.ctx, comment, r.actor);
            done = "Noted. You will not be notified again for this alarm.";
        }
        else if (action === "clear" && r.canClear)
        {
            await actions.clear(r.ctx, comment, r.actor);
            done = "Alarm cleared.";
        }
        else
        {
            return render(res, r, { error: "You do not have permission for that action." });
        }
        await tokens.consume("alarm_action", req.params.token);
        await activity.log(req, "alarm_" + action, { actor_type: r.actor.type, actor_id: r.actor.id, actor_name: r.actor.name, entity_type: "alarm", entity_uid: r.ctx.uid, detail: comment });
        render(res, r, { done: done });
    }
    catch (err) { next(err); }
});

module.exports = router;
