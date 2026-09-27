const express = require("express");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch, insertId } = require("../../db/knex");
const { notFoundError } = require("../../middleware/errors");
const { isUuid } = require("../../middleware/account");
const permissions = require("../../permissions");
const grants = require("../../services/grants");
const activity = require("../../services/activity");
const { bits } = require("./shared");

const router = express.Router();
const settings = require("../../config/settings");
const grantsRepo = require("../../db/repos/grants");
const apiAuth = require("../../services/apiAuth");

router.get("/api", async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        const canManage = permissions.has(b, permissions.byName.grant);
        const creds = await knex(T("api_credentials")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name");
        for (const c of creds) { const g = await knex(T("grants")).where({ grantee_type: "api_credential", grantee_id: c.id, scope_type: "account", scope_id: req.account.id }).first(); c.names = g ? permissions.names(g.permission_bits) : []; }
        const hooks = await knex(T("webhooks")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name");
        for (const h of hooks) { h.recent = await knex(T("webhook_deliveries")).where({ webhook_id: h.id }).orderBy("epoch", "desc").limit(5); }
        const shown = req.session.newApiKey || null; delete req.session.newApiKey;
        const newSecret = req.session.newWebhookSecret || null; delete req.session.newWebhookSecret;
        res.render("account/api", { title: "API and webhooks", creds: creds, hooks: hooks, canManage: canManage, ceiling: b, permissions: permissions, keyPrefix: apiAuth.keyPrefix(), newKey: shown, newSecret: newSecret, apiBase: require("../../config/env").appUrl + "/api/v1" });
    }
    catch (err) { next(err); }
});

router.post("/api", body("name").trim().isLength({ min: 1, max: 80 }), async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        if (!permissions.has(b, permissions.byName.grant)) { return next(notFoundError()); }
        if (req.body.uid && !isUuid(req.body.uid)) { return next(notFoundError()); }
        if (req.body.action === "revoke" && req.body.uid)
        {
            const c = await knex(T("api_credentials")).where({ uid: req.body.uid, account_id: req.account.id }).first();
            if (c) { await knex(T("api_credentials")).where({ id: c.id }).update({ delete_epoch: nowEpoch(), is_enabled: 0 }); await knex(T("grants")).where({ grantee_type: "api_credential", grantee_id: c.id }).del(); }
            req.flash("success", "Credential revoked.");
            return res.redirect(req.acctBase + "/api");
        }
        const keyPrefix = apiAuth.keyPrefix();
        if (!keyPrefix) { req.flash("danger", "API keys cannot be created until API_KEY_PREFIX is set in Admin > Site settings > API."); return res.redirect(req.acctBase + "/api"); }
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect(req.acctBase + "/api"); }
        const requested = permissions.bitsOf([].concat(req.body.perms || []));
        if (!grants.withinCeiling(b, requested) || requested === 0n) { req.flash("danger", "Pick permissions you hold."); return res.redirect(req.acctBase + "/api"); }
        const k = apiAuth.generate(keyPrefix);
        const now = nowEpoch();
        const r = await knex(T("api_credentials")).insert({ account_id: req.account.id, name: req.body.name.trim(), key_prefix: k.prefix, key_hash: k.hash, expires_epoch: req.body.expires_days ? now + Number(req.body.expires_days) * 86400 : null, created_epoch: now, created_by: req.user.id }).returning("id");
        const id = insertId(r);
        await grantsRepo.upsert({ grantee_type: "api_credential", grantee_id: id, scope_type: "account", scope_id: req.account.id, permission_bits: requested.toString(), created_epoch: now, created_by: req.user.id });
        await activity.log(req, "api_credential_created", { detail: req.body.name.trim() });
        req.session.newApiKey = k.key;     // shown once on the next page load, never stored
        res.redirect(req.acctBase + "/api");
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
            return res.redirect(req.acctBase + "/api");
        }
        if (req.body.action === "toggle" && req.body.uid)
        {
            const h = await knex(T("webhooks")).where({ uid: req.body.uid, account_id: req.account.id }).first();
            if (h) { await knex(T("webhooks")).where({ id: h.id }).update({ is_enabled: h.is_enabled ? 0 : 1 }); }
            return res.redirect(req.acctBase + "/api");
        }
        if (!validationResult(req).isEmpty() || !/^https?:\/\//.test(req.body.url || "")) { req.flash("danger", "Name and an http(s) URL are required."); return res.redirect(req.acctBase + "/api"); }
        const events = [].concat(req.body.events || []).filter((e) => ["reading", "alarm"].includes(e));
        if (!events.length) { req.flash("danger", "Pick at least one event type."); return res.redirect(req.acctBase + "/api"); }
        const secret = require("crypto").randomBytes(24).toString("base64url");
        await knex(T("webhooks")).insert({ account_id: req.account.id, name: req.body.name.trim(), url: req.body.url.trim(), signing_secret_enc: settings.encrypt(secret), event_types: events.join(","), created_epoch: nowEpoch() });
        req.session.newWebhookSecret = secret;
        req.flash("success", "Webhook added. Copy the signing secret below; it is shown once.");
        res.redirect(req.acctBase + "/api");
    }
    catch (err) { next(err); }
});

module.exports = router;
