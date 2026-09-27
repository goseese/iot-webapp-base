const express = require("express");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch, insertId } = require("../../db/knex");
const { notFoundError } = require("../../middleware/errors");
const { isUuid } = require("../../middleware/account");
const permissions = require("../../permissions");
const activity = require("../../services/activity");
const { bits } = require("./shared");

const router = express.Router();
async function groupsPage(req, res, next)
{
    try
    {
        const b = await bits(req);
        const groups = await knex(T("alert_groups")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy([{ column: "is_default", order: "desc" }, "name"]);
        for (const g of groups)
        {
            g.levels = await knex(T("alert_group_levels")).where({ alert_group_id: g.id }).orderBy("level_no");
            for (const l of g.levels) { l.recipients = await knex(T("alert_group_recipients")).where({ level_id: l.id }); }
        }
        const contacts = await knex(T("contacts")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name");
        const users = await knex(T("grants") + " as g").join(T("users") + " as u", "u.id", "g.grantee_id").where({ "g.grantee_type": "user", "g.scope_type": "account", "g.scope_id": req.account.id }).whereNull("u.delete_epoch").select("u.id", "u.username", "u.display_name", "u.email");
        const locUsers = await knex(T("grants") + " as g").join(T("users") + " as u", "u.id", "g.grantee_id").join(T("locations") + " as l", "l.id", "g.scope_id").where({ "g.grantee_type": "user", "g.scope_type": "location", "l.account_id": req.account.id }).whereNull("u.delete_epoch").select("u.id", "u.username", "u.display_name", "u.email");
        const seen = new Map(); users.concat(locUsers).forEach((u) => seen.set(u.id, u));
        const editing = req.query.edit ? groups.find((g) => String(g.uid).toLowerCase() === req.query.edit.toLowerCase()) : null;
        res.render("account/alert-groups", { title: "Alert groups", groups: groups, contacts: contacts, users: Array.from(seen.values()), editing: editing, editNew: req.query.edit === "new", canManage: permissions.has(b, permissions.byName.manage_alarms), permissions: permissions });
    }
    catch (err) { next(err); }
}
router.get("/alert-groups", groupsPage);

function parseLevels(body)
{
    const levels = [];
    for (let i = 1; i <= 10; i++)
    {
        if (body["level_" + i + "_present"] === undefined) { continue; }
        const recips = [].concat(body["level_" + i + "_recipients"] || []);
        levels.push({ wait: Math.max(0, Number(body["level_" + i + "_wait"] || 0)), recipients: recips });
    }
    return levels;
}

async function saveGroup(req, groupId)
{
    const b = req.body;
    const tagQuery = (b.tq_any || b.tq_all || b.tq_none || b.tq_text) ? JSON.stringify({ any: (b.tq_any || "").split(",").map((s) => s.trim()).filter(Boolean), all: (b.tq_all || "").split(",").map((s) => s.trim()).filter(Boolean), none: (b.tq_none || "").split(",").map((s) => s.trim()).filter(Boolean), text: (b.tq_text || "").trim() }) : null;
    await knex.transaction(async (trx) =>
    {
        let id = groupId;
        if (id)
        {
            await trx(T("alert_groups")).where({ id: id }).update({ name: b.name.trim(), tag_query: tagQuery });
            const oldLevels = await trx(T("alert_group_levels")).where({ alert_group_id: id });
            for (const l of oldLevels) { await trx(T("alert_group_recipients")).where({ level_id: l.id }).del(); }
            await trx(T("alert_group_levels")).where({ alert_group_id: id }).del();
        }
        else
        {
            const r = await trx(T("alert_groups")).insert({ account_id: req.account.id, name: b.name.trim(), tag_query: tagQuery, created_epoch: nowEpoch() }).returning("id");
            id = insertId(r);
        }
        let n = 1;
        for (const level of parseLevels(b))
        {
            const r = await trx(T("alert_group_levels")).insert({ alert_group_id: id, level_no: n, wait_minutes: n === 1 ? 0 : level.wait }).returning("id");
            const levelId = insertId(r);
            for (const rec of level.recipients)
            {
                const [type, rid] = rec.split(":");
                if (type === "all_access") { await trx(T("alert_group_recipients")).insert({ level_id: levelId, recipient_type: "all_access", recipient_id: null }); }
                else if ((type === "user" || type === "contact") && Number(rid)) { await trx(T("alert_group_recipients")).insert({ level_id: levelId, recipient_type: type, recipient_id: Number(rid) }); }
            }
            n++;
        }
        if (b.is_default)
        {
            await trx(T("alert_groups")).where({ account_id: req.account.id }).update({ is_default: 0 });
            await trx(T("alert_groups")).where({ id: id }).update({ is_default: 1 });
        }
        return id;
    });
}

router.post("/alert-groups", body("name").trim().isLength({ min: 1, max: 80 }), async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        if (!permissions.has(b, permissions.byName.manage_alarms)) { return next(notFoundError()); }
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect(req.acctBase + "/alert-groups"); }
        if (req.body.uid && !isUuid(req.body.uid)) { return next(notFoundError()); }
        const existing = req.body.uid ? await knex(T("alert_groups")).where({ uid: req.body.uid, account_id: req.account.id }).whereNull("delete_epoch").first() : null;
        if (req.body.action === "delete" && existing)
        {
            if (existing.is_default) { req.flash("danger", "Make another group the default first."); return res.redirect(req.acctBase + "/alert-groups"); }
            await knex(T("alert_groups")).where({ id: existing.id }).update({ delete_epoch: nowEpoch() });
            req.flash("success", "Alert group removed.");
            return res.redirect(req.acctBase + "/alert-groups");
        }
        await saveGroup(req, existing ? existing.id : null);
        await activity.log(req, "alert_group_saved", { detail: req.body.name.trim() });
        req.flash("success", "Alert group saved.");
        res.redirect(req.acctBase + "/alert-groups");
    }
    catch (err) { next(err); }
});

router.post("/contacts", body("name").trim().isLength({ min: 1, max: 80 }), async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        if (!permissions.has(b, permissions.byName.manage_alarms)) { return next(notFoundError()); }
        if (req.body.uid && !isUuid(req.body.uid)) { return next(notFoundError()); }
        if (req.body.action === "delete" && req.body.uid)
        {
            await knex(T("contacts")).where({ uid: req.body.uid, account_id: req.account.id }).update({ delete_epoch: nowEpoch() });
            req.flash("success", "Contact removed.");
            return res.redirect(req.acctBase + "/alert-groups");
        }
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect(req.acctBase + "/alert-groups"); }
        const email = (req.body.email || "").trim().toLowerCase() || null;
        // SMS is hidden in this app: contacts are email only and phone is never taken from a form.
        if (!email) { req.flash("danger", "A contact needs an email."); return res.redirect(req.acctBase + "/alert-groups"); }
        await knex(T("contacts")).insert({ account_id: req.account.id, name: req.body.name.trim(), email: email, created_epoch: nowEpoch() });
        req.flash("success", "Contact added.");
        res.redirect(req.acctBase + "/alert-groups");
    }
    catch (err) { next(err); }
});

module.exports = router;
