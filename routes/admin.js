// Superadmin only: accounts, unknown devices, site settings, activity (architecture 12, 13).
const express = require("express");
const { notFoundError } = require("../middleware/errors");
const { body, validationResult } = require("express-validator");
const { knex, T } = require("../db/knex");
const { requireSuperadmin } = require("../middleware/auth");
const settings = require("../config/settings");
const accountService = require("../services/accounts");
const registry = require("../db/repos/registry");
const credentials = require("../db/repos/credentials");
const activity = require("../services/activity");
const deviceTypes = require("../deviceTypes");
const deviceFlows = require("../services/deviceFlows");

const router = express.Router();
router.use(requireSuperadmin);

router.get("/", (req, res) => res.redirect("/admin/accounts"));

router.get("/accounts", async (req, res, next) =>
{
    try
    {
        const accounts = await knex(T("accounts")).whereNull("delete_epoch").orderBy("name");
        for (const a of accounts)
        {
            a.locations = Number((await knex(T("locations")).where({ account_id: a.id }).whereNull("delete_epoch").count("id as n").first()).n);
            a.devices = Number((await knex(T("devices") + " as d").join(T("locations") + " as l", "l.id", "d.location_id").where("l.account_id", a.id).whereNull("d.delete_epoch").where("d.is_archived", 0).count("d.id as n").first()).n);
            a.users = Number((await knex(T("grants")).where({ grantee_type: "user", scope_type: "account", scope_id: a.id }).count("id as n").first()).n);
            a.alarms = Number((await knex(T("alarms") + " as x").join(T("sensors") + " as s", "s.id", "x.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id").where("l.account_id", a.id).whereNull("x.cleared_epoch").count("x.id as n").first()).n);
        }
        res.render("admin/accounts", { title: "Accounts", accounts: accounts });
    }
    catch (err) { next(err); }
});

router.post("/accounts", body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect("/admin/accounts"); }
        const a = await accountService.create(req.body.name.trim(), req.user);
        await activity.log(req, "account_created", { entity_type: "account", entity_uid: a.uid });
        req.flash("success", "Account " + a.name + " created.");
        res.redirect("/account/" + String(a.uid).toLowerCase() + "/locations");
    }
    catch (err) { next(err); }
});

router.post("/accounts/:uid", async (req, res, next) =>
{
    try
    {
        const a = await knex(T("accounts")).where({ uid: req.params.uid }).whereNull("delete_epoch").first();
        if (!a) { return next(notFoundError()); }
        if (req.body.action === "toggle")
        {
            await accountService.update(a, { is_enabled: a.is_enabled ? 0 : 1 }, req.user);
            req.flash("success", a.name + (a.is_enabled ? " disabled." : " enabled."));
        }
        await activity.log(req, "account_" + req.body.action, { entity_type: "account", entity_uid: a.uid });
        res.redirect("/admin/accounts");
    }
    catch (err) { next(err); }
});

// Unknown devices: registry rows with no live device (architecture 3.8). Claim adds them somewhere.
router.get("/unknown-devices", async (req, res, next) =>
{
    try
    {
        const showIgnored = req.query.ignored === "1";
        const rows = await registry.listUnknown(showIgnored);
        for (const r of rows)
        {
            // An unclaimed unit declared its type when it provisioned; prefer that over a guess from
            // the model string. A unit with credentials is connected and waiting for a placement.
            r.unit = (await credentials.forMac(r.mac)) || null;
            const declared = r.unit && r.unit.type_slug ? deviceTypes.all[r.unit.type_slug] : null;
            const t = declared || (r.first_model ? deviceTypes.forModel(r.first_model) : null);
            r.typeName = t ? t.displayName : null;
            r.typeSlug = t ? t.slug : null;
        }
        const locations = await knex(T("locations") + " as l").join(T("accounts") + " as a", "a.id", "l.account_id").whereNull("l.delete_epoch").whereNull("a.delete_epoch").select("l.*", "a.name as account_name").orderBy(["a.name", "l.name"]);
        res.render("admin/unknown-devices", { title: "Unknown devices", rows: rows, showIgnored: showIgnored, locations: locations, types: Object.values(deviceTypes.all).filter((t) => t.slug !== "platform_server") });
    }
    catch (err) { next(err); }
});

router.post("/unknown-devices/claim", async (req, res, next) =>
{
    try
    {
        const location = await knex(T("locations")).where({ id: Number(req.body.location_id) }).whereNull("delete_epoch").first();
        if (!location) { req.flash("danger", "Pick a location."); return res.redirect("/admin/unknown-devices"); }
        const r = await deviceFlows.addByMac({ mac: req.body.mac, name: (req.body.name || "").trim() || req.body.mac, typeSlug: req.body.type || null, location: location, deliberate: true }, req, req.user);
        await activity.log(req, "device_claimed", { entity_type: "device", entity_uid: r.device.uid });
        req.flash("success", r.device.name + " added to " + location.name + ".");
        res.redirect("/devices/" + String(r.device.uid).toLowerCase());
    }
    catch (err) { req.flash("danger", err.message); res.redirect("/admin/unknown-devices"); }
});

// Superadmin ignore (DECISIONS "Unclaimed devices, per account"): hides a MAC from this page only,
// never from an account. JSON for the bulk bar.
async function adminIgnore(req, res, ignore)
{
    try
    {
        const mac = require("../services/devices").normalizeMac(req.params.mac || "");
        if (!/^[0-9A-F]{12}$/.test(mac)) { return res.json({ ok: false, message: "Not a MAC." }); }
        const changed = await require("../services/unclaimed").setIgnored(null, mac, ignore, req.user);
        if (changed) { await activity.log(req, ignore ? "unknown_ignored" : "unknown_unignored", { entity_type: "unit", detail: mac }); }
        res.json({ ok: true, message: ignore ? "Ignored." : "Unignored.", state: { ignored: ignore } });
    }
    catch (err) { res.json({ ok: false, message: err.message }); }
}
router.post("/unknown-devices/:mac/ignore", (req, res) => adminIgnore(req, res, true));
router.post("/unknown-devices/:mac/unignore", (req, res) => adminIgnore(req, res, false));

// Revoke an unclaimed unit's credentials, the same as Reprovision on a device page but for a unit
// with no placement to click through from.
router.post("/unknown-devices/reprovision", async (req, res, next) =>
{
    try
    {
        const provisioning = require("../services/provisioning");
        const mac = provisioning.normalizeMac(req.body.mac);
        const done = mac.length === 12 ? await provisioning.resetUnit(mac) : false;
        if (!done) { req.flash("danger", "That unit holds no credentials."); return res.redirect("/admin/unknown-devices"); }
        await activity.log(req, "unit_reprovision", { entity_type: "unit", detail: mac });
        req.flash("success", "Credentials revoked for " + mac + ". It provisions again on its next contact.");
        res.redirect("/admin/unknown-devices");
    }
    catch (err) { req.flash("danger", err.message); res.redirect("/admin/unknown-devices"); }
});

// No "sms" tab: SMS is hidden in this app and SMS_DRIVER stays at its seeded "none".
const GROUPS = [["general", "General"], ["email", "Email"], ["mqtt", "MQTT"], ["logging", "Logging and purge"], ["api", "API"]];

function settingsTabs(current)
{
    return GROUPS.map((g) => ({ label: g[1], path: "/admin/settings" + (g[0] === "general" ? "" : "/" + g[0]), active: g[0] === current }));
}

async function settingsPage(req, res, next)
{
    try
    {
        const group = GROUPS.some((g) => g[0] === req.params.group) ? req.params.group : "general";
        await settings.reload();
        const all = settings.all().map((s) => Object.assign({}, s, { shown: s.kind === "secret" ? (s.value ? "********" : "") : s.value }));
        const mail = require("../services/mail");
        const sms = require("../services/sms");
        const mailDrivers = Object.values(mail.drivers).map((d) => ({ name: d.name, label: d.label, keys: (d.settings || []).map((x) => x.key), configured: d.configured() }));
        const smsDrivers = Object.values(sms.drivers).map((d) => ({ name: d.name, label: d.label, keys: (d.settings || []).map((x) => x.key), configured: d.configured() }));
        const driverKeys = new Set(mailDrivers.concat(smsDrivers).flatMap((d) => d.keys));
        const rows = all.filter((s) => s.group === group);
        // The client id help shows the actual default for this install (rows are copies, not the cache).
        const idRow = rows.find((s) => s.key === "MQTT_CLIENT_ID");
        if (idRow)
        {
            idRow.description = idRow.description + " Leave blank to use the default: " + require("../mqtt/broker").defaultClientId();
        }
        res.render("admin/settings",
        {
            title: "Site settings", group: group, rows: rows.filter((s) => !driverKeys.has(s.key) && s.key !== "MAIL_DRIVER" && s.key !== "SMS_DRIVER"),
            byKey: Object.fromEntries(all.map((s) => [s.key, s])),
            mailDrivers: mailDrivers, mailChosen: mail.chosen().name, mailActive: mail.active().name, mailFrom: mail.fromAddress(),
            smsDrivers: smsDrivers, smsChosen: settings.get("SMS_DRIVER", "none"),
            navSub: settingsTabs(group), navTrail: [{ label: "Administration", path: "/admin" }, { label: "Site settings", path: "/admin/settings", isCurrent: true }]
        });
    }
    catch (err) { next(err); }
}
router.get("/settings", settingsPage);
router.get("/settings/:group", settingsPage);

// Test send from the Email tab: goes through the normal path so the outcome lands in the log too.
router.post("/settings/email/test", async (req, res, next) =>
{
    try
    {
        const mail = require("../services/mail");
        const r = await mail.send({ kind: "test", to: req.user.email, recipientType: "user", recipientId: req.user.id, subject: settings.siteName() + " test email via " + mail.active().name, text: "Email delivery from " + settings.siteName() + " works (driver " + mail.active().name + ", from " + mail.fromAddress() + ").\n" });
        await activity.log(req, "test_email", { outcome: r.ok ? "ok" : "failed", detail: r.reason || mail.active().name });
        req.flash(r.ok ? "success" : "danger", r.ok ? "Test email sent to " + req.user.email + " via " + mail.active().name + "." : "Send failed: " + r.reason);
        res.redirect("/admin/settings/email");
    }
    catch (err) { next(err); }
});

router.post("/settings/:key", async (req, res, next) =>
{
    try
    {
        const entry = settings.all().find((s) => s.key === req.params.key);
        if (!entry) { return next(notFoundError()); }
        let value = req.body.value;
        if (entry.kind === "bool") { value = req.body.value ? "1" : "0"; }
        if (entry.kind === "int")
        {
            const n = Number(value);
            if (!Number.isInteger(n) || (entry.min !== null && n < entry.min) || (entry.max !== null && n > entry.max)) { req.flash("danger", entry.key + " must be a whole number between " + entry.min + " and " + entry.max + "."); return res.redirect("/admin/settings"); }
            value = String(n);
        }
        if (entry.kind === "secret" && (value === "" || value === "********")) { req.flash("info", "Secret unchanged."); return res.redirect("/admin/settings" + (entry.group !== "general" ? "/" + entry.group : "")); }
        if (entry.kind === "string") { value = String(value === undefined ? "" : value).trim(); }
        if (entry.key === "API_KEY_PREFIX" && !require("../services/apiAuth").KEY_PREFIX_RE.test(value)) { req.flash("danger", "API_KEY_PREFIX must be 1 to 16 characters from A-Z a-z 0-9 - . _ ~."); return res.redirect("/admin/settings/api"); }
        await settings.set(entry.key, value, req.user.id);
        const back = "/admin/settings" + (entry.group && entry.group !== "general" ? "/" + entry.group : "");
        await knex.transaction((trx) => require("../services/audit").audit(trx, { entityType: "setting", entityUid: "00000000-0000-0000-0000-000000000000", entityName: entry.key, field: entry.key, oldValue: entry.kind === "secret" ? "(secret)" : String(entry.value), newValue: entry.kind === "secret" ? "(secret)" : value, actorType: "user", actorId: req.user.id, actorName: req.user.username }));
        await activity.log(req, "setting_changed", { detail: entry.key });
        req.flash(entry.needsRestart ? "warning" : "success", entry.key + " saved." + (entry.needsRestart ? " Restart required." : ""));
        res.redirect(back);
    }
    catch (err) { req.flash("danger", err.message); res.redirect("/admin/settings"); }
});

router.get("/activity", async (req, res, next) =>
{
    try
    {
        const q = knex(T("activity_log")).orderBy("epoch", "desc").limit(300);
        if (req.query.action) { q.where("action", "ilike", req.query.action + "%"); }
        if (req.query.actor) { q.where("actor_name", "ilike", "%" + req.query.actor + "%"); }
        if (req.query.outcome) { q.where("outcome", req.query.outcome); }
        const rows = await q;
        res.render("admin/activity", { title: "Activity", rows: rows, q: req.query });
    }
    catch (err) { next(err); }
});

module.exports = router;
