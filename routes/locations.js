const express = require("express");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch } = require("../db/knex");
const { requireBits } = require("../middleware/auth");
const permissions = require("../permissions");
const locationService = require("../services/locations");
const deviceFlows = require("../services/deviceFlows");
const credentials = require("../db/repos/credentials");
const deviceTypes = require("../deviceTypes");
const display = require("../services/display");
const activity = require("../services/activity");
const title = require("../services/alarms/title");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../middleware/account").uidParam);

// The location's own account uid, for redirects back to that account's pages.
function accountUid(req)
{
    const account = req.visibleAccounts.find((a) => a.id === req.scope.account_id);
    return account ? String(account.uid).toLowerCase() : "";
}

async function common(req)
{
    require("../middleware/account").enterLocation(req, req.scope);
    const account = await knex(T("accounts")).where({ id: req.scope.account_id }).first();
    return { location: req.scope, account: account, bits: req.scopeBits, permissions: permissions };
}

async function deviceRows(locationId, kinds, includeArchived)
{
    const q = knex(T("devices") + " as d").join(T("device_types") + " as t", "t.id", "d.device_type_id")
        .where("d.location_id", locationId).whereNull("d.delete_epoch").whereIn("d.kind", kinds).select("d.*", "t.display_name as type_name", "t.slug as type_slug").orderBy("d.name");
    if (!includeArchived) { q.where("d.is_archived", 0); }
    const rows = await q;
    for (const d of rows)
    {
        const active = await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").where("s.device_id", d.id).whereNull("a.cleared_epoch").count("a.id as n").first();
        d.activeAlarms = Number(active.n);
        d.cred = credentials.isUnitHardware(d) ? await credentials.forDevice(d) : null;
        d.awaiting = credentials.awaiting(d, d.cred);
    }
    return rows;
}

// Offline reasons for the bulk "set offline" modal on the devices and gateways lists.
async function offlineReasons()
{
    const rows = await knex(T("list_items") + " as i").join(T("lists") + " as l", "l.id", "i.list_id").where("l.slug", "offline_reasons").orderBy("i.sort_order").select("i.label");
    return rows.map((r) => r.label);
}

router.get("/:uid", requireBits("location", ["view"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        const d = await require("../services/dashboard").forLocation(req.scope);
        res.render("home/dashboard", Object.assign({ title: "Dashboard", tiles: d.tiles, alarms: d.alarms, sensors: d.sensors }, c));
    }
    catch (err) { next(err); }
});

router.get("/:uid/overview", requireBits("location", ["view"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        const counts = await locationService.counts(req.scope.id);
        const alarms = await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id")
            .where("d.location_id", req.scope.id).whereNull("a.cleared_epoch").select("a.*", "s.name as sensor_name", "s.uid as sensor_uid", "d.name as device_name", "d.uid as device_uid").orderBy("a.raised_epoch", "desc");
        const suppressed = alarms.filter((a) => a.suppressed_by).length;
        res.render("locations/overview", Object.assign({ title: "Overview", counts: counts, alarms: alarms, suppressed: suppressed }, c));
    }
    catch (err) { next(err); }
});

router.get("/:uid/devices", requireBits("location", ["view"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        const devices = await deviceRows(req.scope.id, ["node", "beacon", "direct", "asset"], req.query.archived === "1");
        res.render("locations/devices", Object.assign({ title: "Devices", devices: devices, kinds: "devices", types: Object.values(deviceTypes.all).filter((t) => t.kind !== "gateway" && t.slug !== "platform_server"), archived: req.query.archived === "1", reasons: await offlineReasons() }, c));
    }
    catch (err) { next(err); }
});

// API page for the location's devices (DECISIONS "API tabs"): the calls that list them, from services/apiDocs.js.
router.get("/:uid/devices/api", requireBits("location", ["view"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        const apiDocs = require("../services/apiDocs");
        const api = apiDocs.pageCalls(apiDocs.site(), { kind: "location-devices", location: { uid: String(req.scope.uid).toLowerCase() } });
        res.render("devices/api", Object.assign({ title: "Device API", api: api, docsBase: req.acctBase + "/api/docs" }, c));
    }
    catch (err) { next(err); }
});

router.get("/:uid/gateways", requireBits("location", ["view"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        const devices = await deviceRows(req.scope.id, ["gateway"], req.query.archived === "1");
        res.render("locations/devices", Object.assign({ title: "Gateways", devices: devices, kinds: "gateways", types: Object.values(deviceTypes.all).filter((t) => t.kind === "gateway"), archived: req.query.archived === "1", reasons: await offlineReasons() }, c));
    }
    catch (err) { next(err); }
});

router.get("/:uid/assets", requireBits("location", ["view"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        const devices = await deviceRows(req.scope.id, ["asset"], req.query.archived === "1");
        res.render("locations/devices", Object.assign({ title: "Assets", devices: devices, kinds: "assets", types: Object.values(deviceTypes.all).filter((t) => t.kind === "asset"), archived: req.query.archived === "1" }, c));
    }
    catch (err) { next(err); }
});

// Unclaimed devices heard by this location's gateways: the account page filtered to this location
// (routes/account/unclaimed.js, DECISIONS "Unclaimed devices, per account").
router.get("/:uid/unclaimed", requireBits("location", ["view"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        await require("./account/unclaimed").render(req, res, c.account, req.scope);
    }
    catch (err) { next(err); }
});

// Alarm list pages live here so their links carry the location.
router.use("/:uid/alarms", requireBits("location", ["view"]), (req, res, next) => { require("../middleware/account").enterLocation(req, req.scope); next(); }, require("./alarms").lists);

// MAC lookup for the add dialog: registry prefill and conflict state (architecture 3.8, 7.3).
router.get("/:uid/lookup", requireBits("location", ["add_device"]), async (req, res, next) =>
{
    try
    {
        const look = await deviceFlows.lookup(req.query.mac || "", req);
        res.json(
        {
            mac: look.mac,
            registry: look.registry ? { model: look.registry.first_model, firmware: look.registry.last_firmware, firstHeard: look.registry.first_heard_epoch } : null,
            suggestedType: look.suggestedType ? look.suggestedType.slug : null,
            conflict: look.conflict ? {
                visible: look.conflict.visible,
                deviceName: look.conflict.visible ? look.conflict.device.name : null,
                deviceUid: look.conflict.visible ? String(look.conflict.device.uid).toLowerCase() : null,
                locationName: look.conflict.visible ? look.conflict.location.name : null,
                canArchiveOrMove: look.conflict.canArchiveOrMove, canDelete: look.conflict.canDelete
            } : null
        });
    }
    catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/:uid/devices", requireBits("location", ["add_device"]),
    body("name").trim().isLength({ min: 1, max: 120 }),
    body("mac").trim().isLength({ min: 12, max: 17 }),
    async (req, res, next) =>
    {
        try
        {
            const back = "/locations/" + req.params.uid + (req.body.kinds === "gateways" ? "/gateways" : "/devices");
            if (!validationResult(req).isEmpty()) { req.flash("danger", "Name and MAC are required."); return res.redirect(back); }
            if (req.body.action === "request_access")
            {
                const n = await deviceFlows.requestAccess(req.body.mac, req, req.user, req.scope);
                await activity.log(req, "device_access_requested", { detail: req.body.mac });
                req.flash("info", "Access request sent to " + n + " administrator" + (n === 1 ? "" : "s") + ".");
                return res.redirect(back);
            }
            const r = await deviceFlows.addByMac({ mac: req.body.mac, name: req.body.name.trim(), typeSlug: req.body.type || null, location: req.scope, resolution: req.body.resolution || null, deliberate: true }, req, req.user);
            await activity.log(req, "device_" + r.action, { entity_type: "device", entity_uid: r.device.uid, detail: r.conflictResolved ? "conflict: " + r.conflictResolved : null });
            req.flash("success", r.device.name + (r.action === "moved" ? " moved here." : " added. Waiting for first connection."));
            res.redirect("/devices/" + String(r.device.uid).toLowerCase());
        }
        catch (err)
        {
            req.flash("danger", err.message);
            res.redirect("/locations/" + req.params.uid + (req.body.kinds === "gateways" ? "/gateways" : "/devices"));
        }
    });

router.get("/:uid/users", requireBits("location", ["view"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        const rows = await knex(T("grants") + " as g").join(T("users") + " as u", "u.id", "g.grantee_id").where("g.grantee_type", "user").whereNull("u.delete_epoch")
            .where(function () { this.where({ "g.scope_type": "location", "g.scope_id": req.scope.id }).orWhere({ "g.scope_type": "account", "g.scope_id": req.scope.account_id }); })
            .select("u.username", "u.display_name", "u.email", "g.scope_type", "g.permission_bits").orderBy("u.username");
        res.render("locations/users", Object.assign({ title: "Users", rows: rows }, c));
    }
    catch (err) { next(err); }
});

// Alarm title field for a location: its ALARM_TITLE_FORMAT row in location_settings.
async function locationTitleField(req, c, value)
{
    const inh = await title.inherited("location", { account_id: req.scope.account_id });
    return title.field({ value: value, inherited: inh, sample: { location_name: req.scope.name, account_name: c.account ? c.account.name : undefined } });
}

async function locationTitle(locationId)
{
    const row = await knex(T("location_settings")).where({ location_id: locationId, setting_key: "ALARM_TITLE_FORMAT" }).first();
    return row ? row.setting_value : null;
}

router.get("/:uid/settings", requireBits("location", ["edit"]), async (req, res, next) =>
{
    try
    {
        const c = await common(req);
        const titleField = await locationTitleField(req, c, await locationTitle(req.scope.id));
        res.render("locations/settings", Object.assign({ title: "Settings", values: req.scope, errors: {}, titleField: titleField }, c));
    }
    catch (err) { next(err); }
});

router.post("/:uid/settings", requireBits("location", ["edit"]),
    body("name").trim().isLength({ min: 1, max: 120 }),
    body("iana_timezone").trim().isLength({ min: 1, max: 64 }),
    async (req, res, next) =>
    {
        try
        {
            const c = await common(req);
            const errors = {};
            if (!validationResult(req).isEmpty()) { errors.name = "Required."; }
            try { new Intl.DateTimeFormat("en-US", { timeZone: req.body.iana_timezone }); }
            catch (err) { errors.iana_timezone = "Use an IANA name like America/Chicago."; }
            const lat = req.body.lat === "" ? null : Number(req.body.lat);
            const lng = req.body.lng === "" ? null : Number(req.body.lng);
            if ((lat !== null && Number.isNaN(lat)) || (lng !== null && Number.isNaN(lng))) { errors.lat = "Latitude and longitude must be numbers."; }
            const canLock = permissions.has(req.scopeBits, permissions.byName.lock_location);
            const mode = canLock && ["locked", "normal", "release"].includes(req.body.membership_mode) ? req.body.membership_mode : null;
            if (Object.keys(errors).length > 0)
            {
                const titleField = await locationTitleField(req, c, req.body.alarm_title);
                return res.status(422).render("locations/settings", Object.assign({ title: "Settings", values: Object.assign({}, req.scope, req.body), errors: errors, titleField: titleField }, c));
            }
            const patch = { name: req.body.name.trim(), iana_timezone: req.body.iana_timezone.trim(), address: (req.body.address || "").trim() || null, lat: lat, lng: lng, notes: (req.body.notes || "").trim() || null };
            if (permissions.has(req.scopeBits, permissions.byName.manage_alarms) && ["active", "muted", "offline"].includes(req.body.alarm_mode) && req.body.alarm_mode !== req.scope.alarm_mode)
            {
                await locationService.setAlarmMode(req.scope, req.body.alarm_mode, req.user);
            }
            if (mode) { patch.membership_mode = mode; }
            await locationService.update(req.scope, patch, req.user);
            // Alarm title: a location_settings row; blank deletes it (inherit from the account).
            const oldTitle = await locationTitle(req.scope.id);
            const newTitle = title.clean(req.body.alarm_title);
            if (newTitle !== oldTitle)
            {
                await knex.transaction(async (trx) =>
                {
                    await trx(T("location_settings")).where({ location_id: req.scope.id, setting_key: "ALARM_TITLE_FORMAT" }).del();
                    if (newTitle !== null) { await trx(T("location_settings")).insert({ location_id: req.scope.id, setting_key: "ALARM_TITLE_FORMAT", setting_value: newTitle, updated_epoch: nowEpoch(), updated_by: req.user.id }); }
                    await require("../services/audit").audit(trx, { entityType: "location", entityUid: req.scope.uid, entityName: req.scope.name, field: "alarm_title", oldValue: oldTitle, newValue: newTitle, actorType: "user", actorId: req.user.id, actorName: req.user.username });
                });
            }
            display.invalidate();
            await activity.log(req, "location_updated", { entity_type: "location", entity_uid: req.scope.uid });
            req.flash("success", "Location settings saved.");
            res.redirect("/locations/" + req.params.uid + "/settings");
        }
        catch (err) { next(err); }
    });

// Alarm mode from the locations tab or the settings page (architecture 8.3, 8.6 gate 1).
router.post("/:uid/alarm-mode", requireBits("location", ["manage_alarms"]), async (req, res, next) =>
{
    try
    {
        const mode = String(req.body.mode || "");
        await locationService.setAlarmMode(req.scope, mode, req.user);
        await activity.log(req, "location_alarm_mode", { entity_type: "location", entity_uid: req.scope.uid, detail: mode });
        const msg = { active: "Alarms active for " + req.scope.name + ".", muted: req.scope.name + " muted: alarms record, nobody is notified.", offline: req.scope.name + " offline: readings log, alarms are not evaluated." }[mode];
        req.flash(mode === "active" ? "success" : "warning", msg);
        res.redirect(req.body.back || "/account/" + accountUid(req) + "/locations");
    }
    catch (err) { req.flash("danger", err.message); res.redirect(req.body.back || "/account/" + accountUid(req) + "/locations"); }
});

router.post("/:uid/delete", requireBits("location", ["delete"]), async (req, res, next) =>
{
    try
    {
        if ((req.body.confirm_name || "").trim() !== req.scope.name) { req.flash("danger", "Type the location name exactly to confirm."); return res.redirect("/locations/" + req.params.uid + "/settings"); }
        await locationService.softDelete(req.scope, req.user);
        await activity.log(req, "location_deleted", { entity_type: "location", entity_uid: req.scope.uid });
        req.flash("success", "Location " + req.scope.name + " deleted.");
        res.redirect("/account/" + accountUid(req) + "/locations");
    }
    catch (err) { next(err); }
});

module.exports = router;
