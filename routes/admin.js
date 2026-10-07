// Superadmin only: accounts, unknown devices, pod firmware, site settings, event log (architecture 12, 13).
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
const users = require("../db/repos/users");
const { audit } = require("../services/audit");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../middleware/account").uidParam);
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

// Pod firmware (services/firmware.js, DECISIONS.md "Firmware updates"): one card per image with the
// current file, and its upload.
router.get("/firmware", async (req, res, next) =>
{
    try
    {
        const firmware = require("../services/firmware");
        const cards = [];
        for (const c of firmware.forPage())
        {
            c.file = await firmware.describe(c.image);
            c.waiting = Number((await knex(T("command_queue")).where({ cmd: "ota" }).whereIn("status", ["queued", "sent"]).where("value", "like", "%/firmware/" + c.image + "/%").count("id as n").first()).n);
            cards.push(c);
        }
        res.render("admin/firmware", { title: "Firmware", cards: cards, maxMb: firmware.MAX_BYTES / 1048576 });
    }
    catch (err) { next(err); }
});

// Upload: the page posts the file itself as the body (application/octet-stream), with the CSRF token
// in x-csrf-token and the version and file name in the query. Answers JSON; the page then reloads and
// shows the flash.
router.post("/firmware/:image", async (req, res, next) =>
{
    const firmware = require("../services/firmware");
    const fail = (status, message) => res.status(status).json({ ok: false, message: message });
    try
    {
        const image = req.params.image;
        if (!firmware.images().includes(image)) { return next(notFoundError()); }
        const version = String(req.query.version || "").trim();
        if (!/^[0-9A-Za-z._+-]{1,32}$/.test(version)) { return fail(400, "Give the version, for example 1.0.2 (letters, digits, dots, dashes; up to 32 characters)."); }
        const originalName = String(req.query.name || "").replace(/[^\w .()+-]/g, "").slice(0, 120) || null;

        // Read the body, refusing anything over the limit as it arrives.
        const chunks = [];
        let bytes = 0;
        let tooBig = false;
        await new Promise((resolve, reject) =>
        {
            req.on("data", (d) =>
            {
                bytes += d.length;
                if (bytes > firmware.MAX_BYTES) { tooBig = true; return; }
                chunks.push(d);
            });
            req.on("end", resolve);
            req.on("error", reject);
        });
        if (tooBig) { return fail(413, "That file is larger than " + (firmware.MAX_BYTES / 1048576) + " MB."); }
        const buf = Buffer.concat(chunks);
        const check = firmware.inspect(buf);
        if (!check.ok) { return fail(400, check.error); }

        const md5 = await firmware.store(image, buf, { version: version, built: check.built || null, uploaded_epoch: require("../db/knex").nowEpoch(), uploaded_by: req.user.username, original_name: originalName });
        const stale = Number((await knex(T("command_queue")).where({ cmd: "ota" }).whereIn("status", ["queued", "sent"]).where("value", "like", "%/firmware/" + image + "/%").whereNot("value", "like", "%" + md5 + "%").count("id as n").first()).n);
        await activity.log(req, "firmware_upload", { entity_type: "firmware", entity_uid: image, detail: image + " " + version + ", " + buf.length + " bytes, md5 " + md5 + (originalName ? ", " + originalName : "") });

        let message = image + " " + version + " uploaded (" + (buf.length / 1048576).toFixed(2) + " MB, MD5 " + md5.slice(0, 8) + ").";
        let kind = "success";
        if (!firmware.hasVersion(buf, version)) { message += " Note: \"" + version + "\" does not appear in the file, so check the version; upload again to correct it."; kind = "warning"; }
        if (stale > 0) { message += " " + stale + " update" + (stale === 1 ? " was" : "s were") + " queued for the previous file; the pods will refuse " + (stale === 1 ? "it" : "them") + " (MD5), so cancel and queue again."; kind = "warning"; }
        req.flash(kind, message);
        res.json({ ok: true, message: message });
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
        // Keys the provider panels already show (views/admin/settings.ejs), left out of the list below them.
        const shownAbove = new Set(["MAIL_DRIVER", "SMS_DRIVER", "MAIL_FROM_ADDRESS", "MAIL_FROM_NAME"]);
        const rows = all.filter((s) => s.group === group);
        // The client id help shows the actual default for this install (rows are copies, not the cache).
        const idRow = rows.find((s) => s.key === "MQTT_CLIENT_ID");
        if (idRow)
        {
            idRow.description = idRow.description + " Leave blank to use the default: " + require("../mqtt/broker").defaultClientId();
        }
        // ALARM_TITLE_FORMAT gets the alarm title field (views/partials/alarm-title-field.ejs).
        const titleMod = require("../services/alarms/title");
        const alarmTitleField = titleMod.field({ name: "value", value: settings.get("ALARM_TITLE_FORMAT", ""), inherited: await titleMod.inherited("site", {}), label: false });
        res.render("admin/settings",
        {
            alarmTitleField: alarmTitleField,
            title: "Site settings", group: group, rows: rows.filter((s) => !driverKeys.has(s.key) && !shownAbove.has(s.key)),
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
        // Blank uses the built in default (services/alarms/title.js); stored as "", never "null".
        if (entry.key === "ALARM_TITLE_FORMAT") { value = require("../services/alarms/title").clean(value) || ""; }
        if (entry.key === "API_KEY_PREFIX" && !require("../services/apiAuth").KEY_PREFIX_RE.test(value)) { req.flash("danger", "API_KEY_PREFIX must be 1 to 16 characters from A-Z a-z 0-9 - . _ ~."); return res.redirect("/admin/settings/api"); }
        // Support addresses (services/support.js): every address checked, stored normalised.
        if (entry.key === "SUPPORT_EMAILS" || entry.key === "SUPPORT_FROM_ADDRESS")
        {
            const parsed = require("../services/support").parseAddresses(value);
            if (parsed.bad.length) { req.flash("danger", entry.key + ": not an email address: " + parsed.bad.join(", ")); return res.redirect("/admin/settings/email"); }
            if (entry.key === "SUPPORT_FROM_ADDRESS" && parsed.list.length > 1) { req.flash("danger", "SUPPORT_FROM_ADDRESS takes one address, or blank."); return res.redirect("/admin/settings/email"); }
            value = parsed.list.join(", ");
        }
        await settings.set(entry.key, value, req.user.id);
        const back = "/admin/settings" + (entry.group && entry.group !== "general" ? "/" + entry.group : "");
        await knex.transaction((trx) => require("../services/audit").audit(trx, { entityType: "setting", entityUid: "00000000-0000-0000-0000-000000000000", entityName: entry.key, field: entry.key, oldValue: entry.kind === "secret" ? "(secret)" : String(entry.value), newValue: entry.kind === "secret" ? "(secret)" : value, actorType: "user", actorId: req.user.id, actorName: req.user.username }));
        await activity.log(req, "setting_changed", { detail: entry.key });
        req.flash(entry.needsRestart ? "warning" : "success", entry.key + " saved." + (entry.needsRestart ? " Restart required." : ""));
        res.redirect(back);
    }
    catch (err) { req.flash("danger", err.message); res.redirect("/admin/settings"); }
});

// Per user MFA override (DECISIONS.md "MFA sign in codes"), from the MFA column on Account > Users.
// Superadmin only (router.use above). Inherit is stored as NULL. Saves nothing when unchanged.
const MFA_MODES = { inherit: null, on: "on", off: "off" };
const mfaLabel = (m) => m || "inherit";

router.post("/users/:uid/mfa", async (req, res, next) =>
{
    try
    {
        const back = /^\/account\/[0-9a-f-]{36}\/users$/i.test(String(req.body.back || "")) ? req.body.back : "/account";
        if (!Object.prototype.hasOwnProperty.call(MFA_MODES, req.body.mfa_mode))
        {
            req.flash("danger", "Pick Inherit, On or Off.");
            return res.redirect(back);
        }
        const user = await users.findByUid(req.params.uid);
        if (!user || user.delete_epoch !== null) { return next(notFoundError()); }
        const from = user.mfa_mode || null;
        const to = MFA_MODES[req.body.mfa_mode];
        if (from === to) { return res.redirect(back); }
        await knex.transaction(async (trx) =>
        {
            await users.update(user.id, { mfa_mode: to }, trx);
            await audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: "mfa_mode", oldValue: mfaLabel(from), newValue: mfaLabel(to), actorType: "user", actorId: req.user.id, actorName: req.user.username });
        });
        await activity.log(req, "user_mfa_mode", { entity_type: "user", entity_uid: user.uid, detail: user.username + ": " + mfaLabel(from) + " to " + mfaLabel(to) });
        req.flash("success", "Sign in codes for " + user.username + ": " + (to === null ? "inherit the site setting" : to) + ".");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

// Event log viewer (DECISIONS.md "Event log"). Filters are GET parameters, so a filtered view is a
// shareable link; `who` is u<user id> or k<API key id>. Names come from three small tables loaded
// once per page, not per row.
const LOG_RANGES = { "1h": 3600000, "24h": 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000 };
const LOG_CHANNELS = ["web", "ajax", "api", "device", "job", "mqtt"];
const LOG_PAGE = 500;

router.get("/logs", async (req, res, next) =>
{
    try
    {
        const events = require("../db/repos/events");
        const q = req.query;
        const str = (v) => (typeof v === "string" ? v.trim() : "");
        const f =
        {
            range: LOG_RANGES[q.range] ? q.range : "24h",
            who: /^[uk]\d+$/.test(str(q.who)) ? str(q.who) : "",
            account: /^\d+$/.test(str(q.account)) ? str(q.account) : "",
            event: str(q.event).slice(0, 50),
            channel: LOG_CHANNELS.includes(q.channel) ? q.channel : "",
            cid: /^[0-9a-f]{1,24}$/i.test(str(q.cid)) ? str(q.cid).toLowerCase() : "",
            errors: q.errors === "1",
            before: /^\d+-\d+$/.test(str(q.before)) ? str(q.before) : ""
        };
        const now = Date.now();
        const [beforeTime, beforeId] = f.before ? f.before.split("-").map(Number) : [null, null];
        const rows = await events.list(
        {
            cid: f.cid,
            since: now - LOG_RANGES[f.range],
            beforeTime: beforeTime,
            beforeId: beforeId,
            userId: f.who.startsWith("u") ? Number(f.who.slice(1)) : null,
            apiCredentialId: f.who.startsWith("k") ? Number(f.who.slice(1)) : null,
            accountId: f.account ? Number(f.account) : null,
            event: f.event,
            channel: f.channel,
            errors: f.errors
        }, LOG_PAGE);

        const users = await knex(T("users")).select("id", "username", "delete_epoch").orderBy("username");
        const keys = await knex(T("api_credentials")).select("id", "name", "key_prefix", "delete_epoch").orderBy("name");
        const accounts = await knex(T("accounts")).select("id", "name", "delete_epoch").orderBy("name");
        const names =
        {
            users: Object.fromEntries(users.map((u) => [u.id, u.username])),
            keys: Object.fromEntries(keys.map((k) => [k.id, k.name + " (" + k.key_prefix + ")"])),
            accounts: Object.fromEntries(accounts.map((a) => [a.id, a.name]))
        };
        const eventNames = await events.eventNames(now - LOG_RANGES["7d"]);

        // The next page starts after the last row shown (newest first only; a request's own rows fit one page).
        const last = rows.length === LOG_PAGE && !f.cid ? rows[rows.length - 1] : null;
        const link = (extra) =>
        {
            const p = new URLSearchParams();
            for (const k of ["range", "who", "account", "event", "channel", "cid"]) { if (f[k] && !(k === "range" && f[k] === "24h")) { p.set(k, f[k]); } }
            if (f.errors) { p.set("errors", "1"); }
            for (const [k, v] of Object.entries(extra || {})) { if (v === null) { p.delete(k); } else { p.set(k, v); } }
            const s = p.toString();
            return "/admin/logs" + (s ? "?" + s : "");
        };
        res.render("admin/logs",
        {
            title: "Event log",
            rows: rows,
            f: f,
            users: users,
            keys: keys,
            accounts: accounts,
            names: names,
            eventNames: eventNames,
            channels: LOG_CHANNELS,
            ranges: Object.keys(LOG_RANGES),
            olderLink: last ? link({ before: last.time + "-" + last.id }) : null,
            link: link
        });
    }
    catch (err) { next(err); }
});

module.exports = router;
