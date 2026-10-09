// Superadmin only: accounts, unknown devices, device firmware, site settings, event log (architecture 12, 13).
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
router.param("grantId", require("../middleware/account").intParam);
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

// Device firmware (services/firmware.js, DECISIONS.md "Firmware updates"): one card per image with the
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
        if (stale > 0) { message += " " + stale + " update" + (stale === 1 ? " was" : "s were") + " queued for the previous file; the devices will refuse " + (stale === 1 ? "it" : "them") + " (MD5), so cancel and queue again."; kind = "warning"; }
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

// Display only: the panels on a settings tab and the order of keys in each. A tab key not listed
// here shows in an "Other" panel last, so a new setting never disappears. Unlisted tabs keep one table.
const SECTIONS =
{
    general:
    [
        ["Site", ["SITE_NAME", "THEME_PRIMARY"]],
        ["Sign in and sessions", ["SESSION_HOURS", "LOGIN_MAX_FAILURES", "LOGIN_WINDOW_MINUTES", "MFA_ENABLED", "MFA_CODE_MINUTES"]],
        ["Passwords and invitations", ["PW_MIN_LENGTH", "PW_REQUIRE_UPPER", "PW_REQUIRE_LOWER", "PW_REQUIRE_DIGIT", "PW_REQUIRE_SYMBOL", "RESET_LINK_MINUTES", "INVITE_DAYS", "USERNAME_CHANGE_DAYS"]],
        ["Alarms and devices", ["ALARM_TITLE_FORMAT", "RENOTIFY_MINUTES", "ONLINE_THRESHOLD_SECS", "COVERAGE_WINDOW_HOURS"]],
        ["Charts", ["CHART_EMAIL_DAILY_LIMIT"]]
    ],
    logging:
    [
        ["Data retention", ["RETENTION_DAYS_DEFAULT", "REPORT_FILE_DAYS"]],
        ["Logs and purge", ["EVENT_LOG_DAYS", "DEVICE_FRAMES_HOURS", "RAW_PUBLISH_LOG_DAYS", "PURGE_BATCH_ROWS"]]
    ]
};

function settingsSections(group, rows)
{
    const left = new Map(rows.map((s) => [s.key, s]));
    const out = [];
    for (const [title, keys] of SECTIONS[group] || [])
    {
        const list = keys.filter((k) => left.has(k)).map((k) => left.get(k));
        keys.forEach((k) => left.delete(k));
        if (list.length) { out.push({ title: title, rows: list }); }
    }
    if (left.size) { out.push({ title: out.length ? "Other" : null, rows: Array.from(left.values()) }); }
    return out;
}

// Site settings search: every setting shown on some tab, with its tab. Leaves out the SMS group
// (no tab, SMS is hidden) and the settings of mail drivers other than the chosen one (not shown).
function settingsIndex(all, mailDrivers, mailChosen)
{
    const tabs = new Map(GROUPS);
    const hidden = new Set(mailDrivers.filter((d) => d.name !== mailChosen).flatMap((d) => d.keys));
    return all
        .filter((s) => tabs.has(s.group) && !hidden.has(s.key))
        .map((s) => ({ key: s.key, description: s.description || "", tab: tabs.get(s.group), path: "/admin/settings" + (s.group === "general" ? "" : "/" + s.group) }));
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
            sections: settingsSections(group, rows.filter((s) => !driverKeys.has(s.key) && !shownAbove.has(s.key))),
            searchIndex: settingsIndex(all, mailDrivers, mail.chosen().name),
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
        if (entry.key === "THEME_PRIMARY" && value !== "" && !settings.COLOR_RE.test(value)) { req.flash("danger", "THEME_PRIMARY must be a color as #RRGGBB, for example #45219C, or blank."); return res.redirect("/admin/settings"); }
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
// Administration > Users (DECISIONS.md "Administration > Users"): every live user, searched,
// sorted and paged on the server. Filters are GET parameters, so a view is a shareable link.
// USER_SORTS maps the sort parameter to fixed SQL; nothing from the query reaches orderByRaw.
const USER_PAGE = 25;
const USER_SORTS =
{
    user: "u.username",
    name: "u.display_name",
    email: "u.email",
    access: "grant_count",
    login: "u.last_login_epoch",
    shares: "shares_24h",
    status: "(u.disabled_epoch is not null)"
};

// Grants counted on the list, leaving out deleted accounts and locations (as the user page does).
const ACCOUNT_GRANTS = "(select count(*) from " + T("grants") + " g join " + T("accounts") + " a on a.id = g.scope_id" +
    " where g.grantee_type = 'user' and g.grantee_id = u.id and g.scope_type = 'account' and a.delete_epoch is null)";
const LOCATION_GRANTS = "(select count(*) from " + T("grants") + " g join " + T("locations") + " l on l.id = g.scope_id join " + T("accounts") + " a on a.id = l.account_id" +
    " where g.grantee_type = 'user' and g.grantee_id = u.id and g.scope_type = 'location' and l.delete_epoch is null and a.delete_epoch is null)";

router.get("/users", async (req, res, next) =>
{
    try
    {
        const str = (v) => (typeof v === "string" ? v.trim() : "");
        const f =
        {
            q: str(req.query.q).slice(0, 80),
            sort: Object.prototype.hasOwnProperty.call(USER_SORTS, req.query.sort) ? req.query.sort : "user",
            dir: req.query.dir === "desc" ? "desc" : "asc",
            page: /^\d{1,6}$/.test(str(req.query.page)) ? Math.max(1, Number(req.query.page)) : 1
        };
        const now = require("../db/knex").nowEpoch();
        const base = () =>
        {
            const b = knex(T("users") + " as u").whereNull("u.delete_epoch");
            if (f.q)
            {
                const like = "%" + f.q.replace(/[\\%_]/g, "\\$&") + "%";   // escape LIKE wildcards; backslash is the Postgres default escape
                b.where(function () { this.where("u.username", "ilike", like).orWhere("u.display_name", "ilike", like).orWhere("u.email", "ilike", like); });
            }
            return b;
        };
        const total = Number((await base().count({ n: "*" }).first()).n);
        const pages = Math.max(1, Math.ceil(total / USER_PAGE));
        if (f.page > pages) { f.page = pages; }
        const rows = await base()
            .select("u.id", "u.uid", "u.username", "u.display_name", "u.email", "u.is_superadmin", "u.last_login_epoch", "u.mfa_mode", "u.disabled_epoch",
                "u.chart_email_daily_limit", "u.chart_email_limit_once", "u.chart_email_limit_once_until",
                knex.raw(ACCOUNT_GRANTS + "::int as account_grants"),
                knex.raw(LOCATION_GRANTS + "::int as location_grants"),
                knex.raw("(" + ACCOUNT_GRANTS + " + " + LOCATION_GRANTS + ")::int as grant_count"),
                knex.raw("(select count(*) from " + T("chart_emails") + " c where c.user_id = u.id and c.outcome = 'sent' and c.epoch > ?)::int as shares_24h", [now - 86400]))
            .orderByRaw(USER_SORTS[f.sort] + " " + f.dir + " nulls last")
            .orderBy("u.username")
            .limit(USER_PAGE)
            .offset((f.page - 1) * USER_PAGE);
        const chartEmail = require("../services/chartEmail");
        for (const r of rows) { r.shareLimit = chartEmail.limitFor(r); }
        const mfa = require("../services/mfa");
        const link = (extra) =>
        {
            const p = new URLSearchParams();
            const v = Object.assign({}, f, extra || {});
            if (v.q) { p.set("q", v.q); }
            if (v.sort !== "user") { p.set("sort", v.sort); }
            if (v.dir !== "asc") { p.set("dir", v.dir); }
            if (v.page > 1) { p.set("page", String(v.page)); }
            const s = p.toString();
            return "/admin/users" + (s ? "?" + s : "");
        };
        // A header link sorts by that column; on the current column it flips the direction.
        const sortLink = (key) => link({ sort: key, dir: f.sort === key && f.dir === "asc" ? "desc" : "asc", page: 1 });
        res.render("admin/users",
        {
            title: "Users",
            rows: rows,
            f: f,
            total: total,
            pages: pages,
            pageSize: USER_PAGE,
            link: link,
            sortLink: sortLink,
            siteMfa: mfa.envOff() ? "off" : (settings.get("MFA_ENABLED", false) ? "on" : "off")
        });
    }
    catch (err) { next(err); }
});

// One user (Administration > Users): sign in, alerts, chart email and every grant. Read only here;
// the actions on it post to /admin/users/<uid>/... A deleted user is not found.
router.get("/users/:uid", async (req, res, next) =>
{
    try
    {
        const user = await users.findByUid(req.params.uid);
        if (!user || user.delete_epoch !== null) { return next(notFoundError()); }
        const now = require("../db/knex").nowEpoch();
        const permissions = require("../permissions");
        const mfa = require("../services/mfa");
        const chartEmail = require("../services/chartEmail");
        const accountGrants = await knex(T("grants") + " as g").join(T("accounts") + " as a", "a.id", "g.scope_id")
            .where({ "g.grantee_type": "user", "g.grantee_id": user.id, "g.scope_type": "account" }).whereNull("a.delete_epoch")
            .select("g.id as grant_id", "g.scope_type", "g.permission_bits", "g.created_epoch", "a.name as account_name", "a.uid as account_uid", knex.raw("null as location_name"), knex.raw("null as location_uid"));
        const locationGrants = await knex(T("grants") + " as g").join(T("locations") + " as l", "l.id", "g.scope_id").join(T("accounts") + " as a", "a.id", "l.account_id")
            .where({ "g.grantee_type": "user", "g.grantee_id": user.id, "g.scope_type": "location" }).whereNull("l.delete_epoch").whereNull("a.delete_epoch")
            .select("g.id as grant_id", "g.scope_type", "g.permission_bits", "g.created_epoch", "a.name as account_name", "a.uid as account_uid", "l.name as location_name", "l.uid as location_uid");
        // Account first, then its locations under it.
        const grantRows = accountGrants.concat(locationGrants).sort((x, y) => x.account_name.localeCompare(y.account_name) || (x.location_name || "").localeCompare(y.location_name || ""));
        for (const g of grantRows) { g.names = permissions.names(g.permission_bits); g.all = BigInt(g.permission_bits) === permissions.ALL; }
        const sent = Number((await knex(T("chart_emails")).where({ user_id: user.id, outcome: "sent" }).where("epoch", ">", now - 86400).count({ n: "*" }).first()).n);
        const disabledBy = user.disabled_by ? await users.findById(user.disabled_by) : null;
        // For Add access: every live account with its live locations.
        const scopeAccounts = await knex(T("accounts")).whereNull("delete_epoch").orderBy("name").select("id", "uid", "name");
        const scopeLocations = await knex(T("locations")).whereNull("delete_epoch").orderBy("name").select("account_id", "uid", "name");
        for (const a of scopeAccounts) { a.locations = scopeLocations.filter((l) => l.account_id === a.id); }
        res.render("admin/user",
        {
            title: user.username,
            navTrail: [{ label: "Administration", path: "/admin" }, { label: "Users", path: "/admin/users" }, { label: user.username, path: "/admin/users/" + String(user.uid).toLowerCase() }],
            u: user,
            grantRows: grantRows,
            disabledBy: disabledBy ? disabledBy.username : null,
            shares: { sent: sent, limit: chartEmail.limitFor(user), siteLimit: Number(settings.get("CHART_EMAIL_DAILY_LIMIT", 20)) },
            mfaInfo: { required: mfa.required(user), siteMfa: mfa.envOff() ? "off" : (settings.get("MFA_ENABLED", false) ? "on" : "off"), envOff: mfa.envOff() },
            smsVisible: mfa.SMS_VISIBLE,
            scopeAccounts: scopeAccounts,
            permissions: permissions
        });
    }
    catch (err) { next(err); }
});

// Actions on one user (Administration > Users). Each loads a live user (deleted is not found),
// changes one thing, and returns to the user's page with a confirmation.
const userPage = (user) => "/admin/users/" + String(user.uid).toLowerCase();

async function liveUser(req)
{
    const user = await users.findByUid(req.params.uid);
    return user && user.delete_epoch === null ? user : null;
}

// The same email Forgot password sends (services/resetLink.js); the link is never shown here.
router.post("/users/:uid/reset-link", async (req, res, next) =>
{
    try
    {
        const user = await liveUser(req);
        if (!user) { return next(notFoundError()); }
        // The link would be refused (routes/auth.js), so it is not sent.
        if (user.disabled_epoch) { req.flash("danger", user.username + " is offline. Make them active before sending a reset link."); return res.redirect(userPage(user)); }
        const sent = await require("../services/resetLink").send(user);
        await activity.log(req, "password_reset_sent", { entity_type: "user", entity_uid: user.uid, outcome: sent.ok ? "ok" : "failed", detail: user.username + (sent.ok ? "" : ": " + String(sent.reason || "").slice(0, 200)) });
        if (sent.ok) { req.flash("success", "Password reset link sent to " + user.email + "."); }
        else { req.flash("danger", "The reset link could not be sent: " + (sent.reason || "unknown error").slice(0, 200)); }
        res.redirect(userPage(user));
    }
    catch (err) { next(err); }
});

// Offline or back online (users.disabled_epoch). Offline stops signing in: password, sign in code
// and reset link are refused and open sessions end (middleware/auth.js loadUser). It also stops every
// email and SMS to the user (services/mail, alarms/notify, support). A superadmin cannot put
// themselves offline.
router.post("/users/:uid/offline", async (req, res, next) =>
{
    try
    {
        const user = await liveUser(req);
        if (!user) { return next(notFoundError()); }
        const action = req.body.action;
        if (action !== "offline" && action !== "online") { req.flash("danger", "Pick offline or online."); return res.redirect(userPage(user)); }
        if (action === "offline" && user.id === req.user.id) { req.flash("danger", "You cannot put yourself offline."); return res.redirect(userPage(user)); }
        const isOffline = !!user.disabled_epoch;
        if ((action === "offline") === isOffline) { return res.redirect(userPage(user)); }
        const now = require("../db/knex").nowEpoch();
        const patch = action === "offline" ? { disabled_epoch: now, disabled_by: req.user.id } : { disabled_epoch: null, disabled_by: null };
        await knex.transaction(async (trx) =>
        {
            await users.update(user.id, patch, trx);
            await audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: "status", oldValue: isOffline ? "offline" : "online", newValue: action, actorType: "user", actorId: req.user.id, actorName: req.user.username });
        });
        await activity.log(req, "user_" + action, { entity_type: "user", entity_uid: user.uid, detail: user.username });
        req.flash("success", user.username + (action === "offline" ? " is offline and cannot sign in." : " is active again."));
        res.redirect(userPage(user));
    }
    catch (err) { next(err); }
});

// Alarm email and SMS on or off. The user can turn either back on in their profile. sms_enabled is
// read only when SMS is part of the site (mfa.SMS_VISIBLE; DECISIONS.md "SMS is hidden, not removed").
router.post("/users/:uid/alerts", async (req, res, next) =>
{
    try
    {
        const user = await liveUser(req);
        if (!user) { return next(notFoundError()); }
        const patch = { email_enabled: req.body.email_enabled === "1" };
        if (require("../services/mfa").SMS_VISIBLE) { patch.sms_enabled = req.body.sms_enabled === "1"; }
        const changed = Object.keys(patch).filter((k) => !!user[k] !== patch[k]);
        if (!changed.length) { return res.redirect(userPage(user)); }
        const onOff = (v) => (v ? "on" : "off");
        await knex.transaction(async (trx) =>
        {
            await users.update(user.id, patch, trx);
            for (const k of changed)
            {
                await audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: k, oldValue: onOff(!!user[k]), newValue: onOff(patch[k]), actorType: "user", actorId: req.user.id, actorName: req.user.username });
            }
        });
        const detail = changed.map((k) => k + " " + onOff(!!user[k]) + " to " + onOff(patch[k])).join(", ");
        await activity.log(req, "user_alerts", { entity_type: "user", entity_uid: user.uid, detail: user.username + ": " + detail });
        req.flash("success", "Alerts for " + user.username + ": " + changed.map((k) => (k === "email_enabled" ? "email " : "SMS ") + onOff(patch[k])).join(", ") + ".");
        res.redirect(userPage(user));
    }
    catch (err) { next(err); }
});

// Chart email daily limit (DECISIONS.md "Chart email from the site"). kind:
//   permanent  the user's own limit (users.chart_email_daily_limit); blank goes back to the site setting
//   once       a limit for the next 24 hours that replaces the normal one, then lapses on its own
//   end_once   ends a one time limit now
// Limits are whole numbers from 0 (sending off) to CHART_LIMIT_MAX.
const CHART_LIMIT_MAX = 10000;

router.post("/users/:uid/chart-limit", async (req, res, next) =>
{
    try
    {
        const user = await liveUser(req);
        if (!user) { return next(notFoundError()); }
        const kind = req.body.kind;
        const raw = String(req.body.limit || "").trim();
        const valid = /^\d{1,5}$/.test(raw) && Number(raw) <= CHART_LIMIT_MAX;
        const now = require("../db/knex").nowEpoch();
        let patch = null;
        let field = null;
        let from = null;
        let to = null;
        if (kind === "permanent")
        {
            if (raw !== "" && !valid) { req.flash("danger", "The daily limit is a whole number from 0 to " + CHART_LIMIT_MAX + ", or blank for the site setting."); return res.redirect(userPage(user)); }
            const value = raw === "" ? null : Number(raw);
            if (value === (user.chart_email_daily_limit === null ? null : Number(user.chart_email_daily_limit))) { return res.redirect(userPage(user)); }
            patch = { chart_email_daily_limit: value };
            field = "chart_email_daily_limit";
            from = user.chart_email_daily_limit === null ? "site setting" : String(user.chart_email_daily_limit);
            to = value === null ? "site setting" : String(value);
        }
        else if (kind === "once")
        {
            if (!valid) { req.flash("danger", "The one time limit is a whole number from 0 to " + CHART_LIMIT_MAX + "."); return res.redirect(userPage(user)); }
            patch = { chart_email_limit_once: Number(raw), chart_email_limit_once_until: now + 86400 };
            field = "chart_email_limit_once";
            from = user.chart_email_limit_once !== null && Number(user.chart_email_limit_once_until) > now ? String(user.chart_email_limit_once) : "none";
            to = raw + " for 24 h";
        }
        else if (kind === "end_once")
        {
            if (user.chart_email_limit_once === null) { return res.redirect(userPage(user)); }
            patch = { chart_email_limit_once: null, chart_email_limit_once_until: null };
            field = "chart_email_limit_once";
            from = String(user.chart_email_limit_once);
            to = "none";
        }
        else { req.flash("danger", "Pick a limit to change."); return res.redirect(userPage(user)); }
        await knex.transaction(async (trx) =>
        {
            await users.update(user.id, patch, trx);
            await audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: field, oldValue: from, newValue: to, actorType: "user", actorId: req.user.id, actorName: req.user.username });
        });
        await activity.log(req, "user_chart_limit", { entity_type: "user", entity_uid: user.uid, detail: user.username + ": " + field + " " + from + " to " + to });
        const limit = require("../services/chartEmail").limitFor(Object.assign({}, user, patch), now);
        req.flash("success", "Chart email limit for " + user.username + " is now " + limit + " a day" + (kind === "once" ? " for the next 24 hours." : "."));
        res.redirect(userPage(user));
    }
    catch (err) { next(err); }
});

// Access (grants) on one user, Administration > Users. Superadmins only, so there is no ceiling:
// any permission can be given. Audit rows match Account > Users (routes/account/users.js):
// grant_added, grant_<scope>:<id> for an edit, grant_removed.
function scopeLabel(account, location)
{
    return location ? account.name + " / " + location.name : account.name + " (whole account)";
}

// scope is "a:<account uid>" or "l:<location uid>" from the Add access select.
router.post("/users/:uid/grants", async (req, res, next) =>
{
    try
    {
        const user = await liveUser(req);
        if (!user) { return next(notFoundError()); }
        const permissions = require("../permissions");
        const { isUuid } = require("../middleware/account");
        const m = /^([al]):(.+)$/.exec(String(req.body.scope || ""));
        if (!m || !isUuid(m[2])) { req.flash("danger", "Pick an account or location."); return res.redirect(userPage(user)); }
        let account = null;
        let location = null;
        if (m[1] === "a")
        {
            account = await knex(T("accounts")).where({ uid: m[2] }).whereNull("delete_epoch").first();
        }
        else
        {
            location = await knex(T("locations")).where({ uid: m[2] }).whereNull("delete_epoch").first();
            account = location ? await knex(T("accounts")).where({ id: location.account_id }).whereNull("delete_epoch").first() : null;
        }
        if (!account) { req.flash("danger", "That account or location no longer exists."); return res.redirect(userPage(user)); }
        const requested = permissions.bitsOf([].concat(req.body.perms || []));
        if (requested === 0n) { req.flash("danger", "Pick at least one permission."); return res.redirect(userPage(user)); }
        const key = { grantee_type: "user", grantee_id: user.id, scope_type: location ? "location" : "account", scope_id: location ? location.id : account.id };
        const label = scopeLabel(account, location);
        const duplicate = () => { req.flash("warning", user.username + " already has access to " + label + ". Use Edit in the list to change it."); return res.redirect(userPage(user)); };
        if (await knex(T("grants")).where(key).first()) { return duplicate(); }
        try
        {
            await knex.transaction(async (trx) =>
            {
                await trx(T("grants")).insert(Object.assign({ permission_bits: requested.toString(), created_epoch: require("../db/knex").nowEpoch(), created_by: req.user.id }, key));
                await audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: "grant_added", newValue: key.scope_type + ":" + key.scope_id + " " + permissions.names(requested).join(","), actorType: "user", actorId: req.user.id, actorName: req.user.username });
            });
        }
        catch (err)
        {
            // Two adds at once: the second insert hits ux_grants_scope.
            if (require("../db/knex").isUniqueViolation(err)) { return duplicate(); }
            throw err;
        }
        await activity.log(req, "user_added", { entity_type: "user", entity_uid: user.uid, detail: user.username + " @ " + label });
        req.flash("success", user.username + " now has access to " + label + ".");
        res.redirect(userPage(user));
    }
    catch (err) { next(err); }
});

// Edit a grant's permissions, or remove it (action=remove). The grant must be this user's.
router.post("/users/:uid/grants/:grantId", async (req, res, next) =>
{
    try
    {
        const user = await liveUser(req);
        if (!user) { return next(notFoundError()); }
        const permissions = require("../permissions");
        const g = await knex(T("grants")).where({ id: Number(req.params.grantId), grantee_type: "user", grantee_id: user.id }).first();
        if (!g) { return next(notFoundError()); }
        if (req.body.action === "remove")
        {
            await knex.transaction(async (trx) =>
            {
                await trx(T("grants")).where({ id: g.id }).del();
                await audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: "grant_removed", oldValue: g.scope_type + ":" + g.scope_id + " " + permissions.names(g.permission_bits).join(","), actorType: "user", actorId: req.user.id, actorName: req.user.username });
            });
            req.flash("success", "Access removed for " + user.username + ".");
        }
        else
        {
            const requested = permissions.bitsOf([].concat(req.body.perms || []));
            if (requested === 0n) { req.flash("danger", "Pick at least one permission, or use Remove."); return res.redirect(userPage(user)); }
            if (requested === BigInt(g.permission_bits)) { return res.redirect(userPage(user)); }
            await knex.transaction(async (trx) =>
            {
                await trx(T("grants")).where({ id: g.id }).update({ permission_bits: requested.toString() });
                await audit(trx, { entityType: "user", entityUid: user.uid, entityName: user.username, field: "grant_" + g.scope_type + ":" + g.scope_id, oldValue: permissions.names(g.permission_bits).join(","), newValue: permissions.names(requested).join(","), actorType: "user", actorId: req.user.id, actorName: req.user.username });
            });
            req.flash("success", "Permissions saved for " + user.username + ".");
        }
        await activity.log(req, "grant_changed", { entity_type: "user", entity_uid: user.uid });
        res.redirect(userPage(user));
    }
    catch (err) { next(err); }
});

// Superadmin only (router.use above). Inherit is stored as NULL. Saves nothing when unchanged.
const MFA_MODES = { inherit: null, on: "on", off: "off" };
const mfaLabel = (m) => m || "inherit";

router.post("/users/:uid/mfa", async (req, res, next) =>
{
    try
    {
        // Back to Account > Users or to the user's own Administration > Users page, nowhere else.
        const back = /^\/(account\/[0-9a-f-]{36}\/users|admin\/users\/[0-9a-f-]{36})$/i.test(String(req.body.back || "")) ? req.body.back : "/account";
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
