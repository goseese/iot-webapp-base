// Account > Webhooks: outbound, signed, retried deliveries (services/webhooks.js). Viewing needs the
// account; adding, pausing and removing need Edit (Jeff, Oct 2026).
const express = require("express");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch } = require("../../db/knex");
const { notFoundError } = require("../../middleware/errors");
const { isUuid } = require("../../middleware/account");
const permissions = require("../../permissions");
const settings = require("../../config/settings");
const { bits, docsButton } = require("./shared");
const apiDocs = require("../../services/apiDocs");

const router = express.Router();

router.get("/webhooks/docs", async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        res.render("account/webhooks-docs", { title: "Webhooks", titleActions: docsButton(req), canEdit: permissions.has(b, permissions.byName.edit), docs: apiDocs.build(), apiDocs: apiDocs });
    }
    catch (err) { next(err); }
});

router.get("/webhooks", async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        const canEdit = permissions.has(b, permissions.byName.edit);
        const hooks = await knex(T("webhooks")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name");
        for (const h of hooks) { h.recent = await knex(T("webhook_deliveries")).where({ webhook_id: h.id }).orderBy("epoch", "desc").limit(5); }
        const newSecret = req.session.newWebhookSecret || null; delete req.session.newWebhookSecret;
        res.render("account/webhooks", { title: "Webhooks", hooks: hooks, canEdit: canEdit, newSecret: newSecret });
    }
    catch (err) { next(err); }
});

router.post("/webhooks", body("name").trim().isLength({ min: 1, max: 80 }), async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        if (!permissions.has(b, permissions.byName.edit)) { return next(notFoundError()); }
        if (req.body.uid && !isUuid(req.body.uid)) { return next(notFoundError()); }
        if (req.body.action === "delete" && req.body.uid)
        {
            await knex(T("webhooks")).where({ uid: req.body.uid, account_id: req.account.id }).update({ delete_epoch: nowEpoch(), is_enabled: 0 });
            req.flash("success", "Webhook removed.");
            return res.redirect(req.acctBase + "/webhooks");
        }
        if (req.body.action === "toggle" && req.body.uid)
        {
            const h = await knex(T("webhooks")).where({ uid: req.body.uid, account_id: req.account.id }).first();
            if (h) { await knex(T("webhooks")).where({ id: h.id }).update({ is_enabled: h.is_enabled ? 0 : 1 }); }
            return res.redirect(req.acctBase + "/webhooks");
        }
        if (!validationResult(req).isEmpty() || !/^https?:\/\//.test(req.body.url || "")) { req.flash("danger", "Name and an http(s) URL are required."); return res.redirect(req.acctBase + "/webhooks"); }
        const events = [].concat(req.body.events || []).filter((e) => ["reading", "alarm"].includes(e));
        if (!events.length) { req.flash("danger", "Pick at least one event type."); return res.redirect(req.acctBase + "/webhooks"); }
        const secret = require("crypto").randomBytes(24).toString("base64url");
        await knex(T("webhooks")).insert({ account_id: req.account.id, name: req.body.name.trim(), url: req.body.url.trim(), signing_secret_enc: settings.encrypt(secret), event_types: events.join(","), created_epoch: nowEpoch() });
        req.session.newWebhookSecret = secret;
        req.flash("success", "Webhook added. Copy the signing secret below; it is shown once.");
        res.redirect(req.acctBase + "/webhooks");
    }
    catch (err) { next(err); }
});

module.exports = router;
