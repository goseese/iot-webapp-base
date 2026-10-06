const express = require("express");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch } = require("../../db/knex");
const { notFoundError } = require("../../middleware/errors");
const permissions = require("../../permissions");
const { bits } = require("./shared");

const router = express.Router();
const accountService = require("../../services/accounts");
const metricsMod = require("../../metrics");
const display = require("../../services/display");
const title = require("../../services/alarms/title");
const { audit } = require("../../services/audit");

router.get("/settings", async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        const rows = await knex(T("account_settings")).where({ account_id: req.account.id });
        const current = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
        const unitMetrics = Object.values(metricsMod.all).filter((m) => Object.keys(m.units).length > 0);
        const canEdit = permissions.has(b, permissions.byName.edit);
        const titleField = title.field({ value: current.ALARM_TITLE_FORMAT, inherited: await title.inherited("account", {}), sample: { account_name: req.account.name }, disabled: !canEdit });
        res.render("account/settings", { title: "Account settings", current: current, unitMetrics: unitMetrics, titleField: titleField, canEdit: canEdit, permissions: permissions });
    }
    catch (err) { next(err); }
});

router.post("/settings", body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        if (!permissions.has(b, permissions.byName.edit)) { return next(notFoundError()); }
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect(req.acctBase + "/settings"); }
        if (req.body.name.trim() !== req.account.name) { await accountService.update(req.account, { name: req.body.name.trim() }, req.user); }
        const updates = {};
        for (const m of Object.values(metricsMod.all))
        {
            const v = req.body["unit_" + m.slug];
            if (v === undefined) { continue; }
            updates["DISPLAY_UNIT_" + m.slug] = v === "" ? null : v;
        }
        updates.RETENTION_DAYS = req.body.retention_days === "" ? null : String(Math.max(1, Number(req.body.retention_days) || 90));
        // Alarm title: an account_settings row; blank deletes it (inherit the site default).
        const oldTitle = await knex(T("account_settings")).where({ account_id: req.account.id, setting_key: "ALARM_TITLE_FORMAT" }).first();
        updates.ALARM_TITLE_FORMAT = title.clean(req.body.alarm_title);
        await knex.transaction(async (trx) =>
        {
            const was = oldTitle ? oldTitle.setting_value : null;
            if (updates.ALARM_TITLE_FORMAT !== was)
            {
                await audit(trx, { entityType: "account", entityUid: req.account.uid, entityName: req.account.name, field: "alarm_title", oldValue: was, newValue: updates.ALARM_TITLE_FORMAT, actorType: "user", actorId: req.user.id, actorName: req.user.username });
            }
            for (const [k, v] of Object.entries(updates))
            {
                await trx(T("account_settings")).where({ account_id: req.account.id, setting_key: k }).del();
                if (v !== null) { await trx(T("account_settings")).insert({ account_id: req.account.id, setting_key: k, setting_value: v, updated_epoch: nowEpoch(), updated_by: req.user.id }); }
            }
        });
        display.invalidate();
        req.flash("success", "Account settings saved.");
        res.redirect(req.acctBase + "/settings");
    }
    catch (err) { next(err); }
});

module.exports = router;
