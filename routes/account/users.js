const express = require("express");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch } = require("../../db/knex");
const { notFoundError } = require("../../middleware/errors");
const permissions = require("../../permissions");
const grants = require("../../services/grants");
const activity = require("../../services/activity");
const { bits, ceilingAt } = require("./shared");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../../middleware/account").uidParam);
router.param("grantId", require("../../middleware/account").intParam);
const invitesSvc = require("../../services/invites");
const invitesRepo = require("../../db/repos/invites");

async function usersPage(req, res, next)
{
    try
    {
        const b = await bits(req);
        const canGrant = permissions.has(b, permissions.byName.grant);
        const locations = await knex(T("locations")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name");
        const locIds = locations.map((l) => l.id);
        const rows = await knex(T("grants") + " as g").join(T("users") + " as u", "u.id", "g.grantee_id").where("g.grantee_type", "user").whereNull("u.delete_epoch")
            .where(function () { this.where({ "g.scope_type": "account", "g.scope_id": req.account.id }); if (locIds.length) { this.orWhere(function () { this.where("g.scope_type", "location").whereIn("g.scope_id", locIds); }); } })
            .select("g.id as grant_id", "g.scope_type", "g.scope_id", "g.permission_bits", "u.id as user_id", "u.username", "u.display_name", "u.email", "u.last_login_epoch").orderBy(["u.username", "g.scope_type"]);
        for (const r of rows) { r.scopeName = r.scope_type === "account" ? req.account.name : (locations.find((l) => l.id === r.scope_id) || {}).name; r.names = permissions.names(r.permission_bits); }
        const pending = canGrant ? await knex(T("invites")).whereNull("accepted_epoch").whereNull("cancelled_epoch").where(function () { this.where({ scope_type: "account", scope_id: req.account.id }); if (locIds.length) { this.orWhere(function () { this.where("scope_type", "location").whereIn("scope_id", locIds); }); } }) : [];
        const now = nowEpoch();
        for (const p of pending)
        {
            p.scopeName = p.scope_type === "account" ? req.account.name : (locations.find((l) => l.id === p.scope_id) || {}).name;
            p.expired = Number(p.expires_epoch) < now;
            p.lastMail = await knex(T("notifications")).where({ kind: "invite", address: p.email }).orderBy("epoch", "desc").first();
        }
        // Ceiling: the inviter can only hand out bits they hold at the chosen scope; account scope shown here.
        res.render("account/users", { title: "Users", rows: rows, pending: pending, locations: locations, canGrant: canGrant, ceiling: b, permissions: permissions });
    }
    catch (err) { next(err); }
}
router.get("/users", usersPage);

// Add an existing user (DECISIONS "Add existing users"). Search finds only users who already hold a
// grant on an account the searcher can see or a location the searcher can view (superadmins: all),
// so typing addresses never reveals who else is on the server. The add re-checks the same pool, so
// a posted uid from outside it looks missing.
async function poolScope(req)
{
    if (req.user.is_superadmin) { return null; }
    return { accountIds: await grants.visibleAccountIds(req), locationIds: (await grants.visibleLocations(req)).map((l) => l.id) };
}

function inPool(q, scope)
{
    if (!scope) { return q; }
    return q.whereExists(function ()
    {
        this.select(knex.raw("1")).from(T("grants") + " as pg").whereRaw("pg.grantee_id = u.id").where("pg.grantee_type", "user")
            .where(function ()
            {
                this.where(function () { this.where("pg.scope_type", "account").whereIn("pg.scope_id", scope.accountIds.concat([-1])); })
                    .orWhere(function () { this.where("pg.scope_type", "location").whereIn("pg.scope_id", scope.locationIds.concat([-1])); });
            });
    });
}

router.get("/users/search", async (req, res, next) =>
{
    try
    {
        if (!permissions.has(await bits(req), permissions.byName.grant)) { return next(notFoundError()); }
        const text = String(req.query.q || "").trim().slice(0, 100);
        if (text.length < 2) { return res.json({ ok: true, users: [] }); }
        const like = "%" + text.replace(/[\\%_]/g, "\\$&") + "%";   // escape LIKE wildcards; backslash is the Postgres default escape
        const users = await inPool(knex(T("users") + " as u").whereNull("u.delete_epoch").whereNot("u.id", req.user.id), await poolScope(req))
            .where(function () { this.where("u.email", "ilike", like).orWhere("u.username", "ilike", like).orWhere("u.display_name", "ilike", like); })
            .select("u.id", "u.uid", "u.username", "u.display_name", "u.email").orderBy("u.username").limit(20);
        // What each already holds in this account, so the modal can say so before adding.
        const locations = await knex(T("locations")).where({ account_id: req.account.id }).whereNull("delete_epoch").select("id", "name");
        const held = users.length ? await knex(T("grants")).where("grantee_type", "user").whereIn("grantee_id", users.map((u) => u.id))
            .where(function () { this.where({ scope_type: "account", scope_id: req.account.id }).orWhere(function () { this.where("scope_type", "location").whereIn("scope_id", locations.map((l) => l.id).concat([-1])); }); }) : [];
        res.json({ ok: true, users: users.map((u) => (
        {
            uid: String(u.uid).toLowerCase(),
            username: u.username,
            display_name: u.display_name,
            email: u.email,
            access: held.filter((g) => g.grantee_id === u.id).map((g) => g.scope_type === "account" ? req.account.name : (locations.find((l) => l.id === g.scope_id) || {}).name)
        })) });
    }
    catch (err) { next(err); }
});

router.post("/users/add", async (req, res, next) =>
{
    try
    {
        const scopeType = req.body.scope_type === "location" ? "location" : "account";
        const scopeId = scopeType === "account" ? req.account.id : (Number(req.body.scope_id) || 0);
        const ceiling = await ceilingAt(req, scopeType, scopeId);
        if (!permissions.has(ceiling, permissions.byName.grant)) { return next(notFoundError()); }
        const uid = String(req.body.user || "");
        if (!require("../../middleware/account").GUID_RE.test(uid)) { return next(notFoundError()); }
        const user = await inPool(knex(T("users") + " as u").whereNull("u.delete_epoch").where("u.uid", uid), await poolScope(req)).select("u.*").first();
        if (!user) { return next(notFoundError()); }
        const requested = permissions.bitsOf([].concat(req.body.perms || []));
        if (!grants.withinCeiling(ceiling, requested)) { req.flash("danger", "You can only grant permissions you hold at that scope."); return res.redirect(req.acctBase + "/users"); }
        if (requested === 0n) { req.flash("danger", "Pick at least one permission."); return res.redirect(req.acctBase + "/users"); }
        const scopeName = scopeType === "account" ? req.account.name : (await knex(T("locations")).where({ id: scopeId }).first()).name;
        const key = { grantee_type: "user", grantee_id: user.id, scope_type: scopeType, scope_id: scopeId };
        if (await knex(T("grants")).where(key).first())
        {
            req.flash("warning", user.username + " already has access to " + scopeName + ". Use Edit in the list to change it.");
            return res.redirect(req.acctBase + "/users");
        }
        await knex.transaction(async (trx) =>
        {
            await trx(T("grants")).insert(Object.assign({ permission_bits: requested.toString(), created_epoch: nowEpoch(), created_by: req.user.id }, key));
            await require("../../services/audit").audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: "grant_added", newValue: scopeType + ":" + scopeId + " " + permissions.names(requested).join(","), actorType: "user", actorId: req.user.id, actorName: req.user.username });
        });
        await activity.log(req, "user_added", { entity_type: "user", entity_uid: user.uid, detail: user.username + " @ " + scopeName });
        req.flash("success", (user.display_name || user.username) + " now has access to " + scopeName + ".");
        res.redirect(req.acctBase + "/users");
    }
    catch (err) { next(err); }
});


router.post("/users/invite",
    body("email").trim().isEmail(), body("username").trim().isLength({ min: 3, max: 40 }).matches(/^[^@\s]+$/),
    async (req, res, next) =>
    {
        try
        {
            if (!validationResult(req).isEmpty()) { req.flash("danger", "A valid email and a username (3 to 40 chars, no spaces or @) are required."); return res.redirect(req.acctBase + "/users"); }
            const scopeType = req.body.scope_type === "location" ? "location" : "account";
            const scopeId = scopeType === "account" ? req.account.id : Number(req.body.scope_id);
            const ceiling = await ceilingAt(req, scopeType, scopeId);
            if (!permissions.has(ceiling, permissions.byName.grant)) { return next(notFoundError()); }
            const requested = permissions.bitsOf([].concat(req.body.perms || []));
            if (!grants.withinCeiling(ceiling, requested)) { req.flash("danger", "You can only grant permissions you hold at that scope."); return res.redirect(req.acctBase + "/users"); }
            if (requested === 0n) { req.flash("danger", "Pick at least one permission."); return res.redirect(req.acctBase + "/users"); }
            const scopeName = scopeType === "account" ? req.account.name : (await knex(T("locations")).where({ id: scopeId }).first()).name;
            await invitesSvc.invite({ email: req.body.email, username: req.body.username.trim(), scopeType: scopeType, scopeId: scopeId, scopeName: scopeName, bits: requested, invitedBy: req.user });
            await activity.log(req, "user_invited", { detail: req.body.email.trim().toLowerCase() + " @ " + scopeName });
            req.flash("success", "Done. " + req.body.email.trim() + " has been sent an email.");   // same wording whether added or invited
            res.redirect(req.acctBase + "/users");
        }
        catch (err) { next(err); }
    });

router.post("/users/grant/:grantId", async (req, res, next) =>
{
    try
    {
        const g = await knex(T("grants")).where({ id: Number(req.params.grantId), grantee_type: "user" }).first();
        if (!g) { return next(notFoundError()); }
        const ceiling = await ceilingAt(req, g.scope_type, g.scope_id);
        if (!permissions.has(ceiling, permissions.byName.grant)) { return next(notFoundError()); }
        const user = await knex(T("users")).where({ id: g.grantee_id }).first();
        if (req.body.action === "remove")
        {
            if (!grants.withinCeiling(ceiling, g.permission_bits)) { req.flash("danger", "That grant holds permissions above yours; you cannot remove it."); return res.redirect(req.acctBase + "/users"); }
            await knex(T("grants")).where({ id: g.id }).del();
            await knex.transaction((trx) => require("../../services/audit").audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: "grant_removed", oldValue: g.scope_type + ":" + g.scope_id + " " + permissions.names(g.permission_bits).join(","), actorType: "user", actorId: req.user.id, actorName: req.user.username }));
            req.flash("success", "Access removed for " + user.username + ".");
        }
        else
        {
            const requested = permissions.bitsOf([].concat(req.body.perms || []));
            // May only change bits within the ceiling; bits above it stay as they were.
            const above = BigInt(g.permission_bits) & ~BigInt(ceiling);
            const next_ = (requested & BigInt(ceiling)) | above;
            await knex(T("grants")).where({ id: g.id }).update({ permission_bits: next_.toString() });
            await knex.transaction((trx) => require("../../services/audit").audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: "grant_" + g.scope_type + ":" + g.scope_id, oldValue: permissions.names(g.permission_bits).join(","), newValue: permissions.names(next_).join(","), actorType: "user", actorId: req.user.id, actorName: req.user.username }));
            req.flash("success", "Permissions saved for " + user.username + ".");
        }
        await activity.log(req, "grant_changed", { entity_type: "user", entity_uid: user.uid });
        res.redirect(req.acctBase + "/users");
    }
    catch (err) { next(err); }
});

router.post("/users/invite/:uid/resend", async (req, res, next) =>
{
    try
    {
        const inv = await invitesRepo.findByUid(req.params.uid);
        if (!inv || inv.accepted_epoch) { return next(notFoundError()); }
        const ceiling = await ceilingAt(req, inv.scope_type, inv.scope_id);
        if (!permissions.has(ceiling, permissions.byName.grant)) { return next(notFoundError()); }
        const r = await invitesSvc.resend(inv, req.user);
        await activity.log(req, "user_invite_resent", { detail: inv.email, outcome: r.ok ? "ok" : "failed" });
        req.flash(r.ok ? "success" : "danger", r.ok ? "A new invitation was sent to " + inv.email + "." : "Invitation renewed but the email failed: " + r.reason);
        res.redirect(req.acctBase + "/users");
    }
    catch (err) { next(err); }
});

router.post("/users/invite/:uid/cancel", async (req, res, next) =>
{
    try
    {
        const inv = await invitesRepo.findByUid(req.params.uid);
        if (!inv) { return next(notFoundError()); }
        const ceiling = await ceilingAt(req, inv.scope_type, inv.scope_id);
        if (!permissions.has(ceiling, permissions.byName.grant)) { return next(notFoundError()); }
        await invitesRepo.update(inv.id, { cancelled_epoch: nowEpoch() });
        req.flash("success", "Invitation cancelled.");
        res.redirect(req.acctBase + "/users");
    }
    catch (err) { next(err); }
});

module.exports = router;
