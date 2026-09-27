const express = require("express");
const { notFoundError } = require("../middleware/errors");
const { body, validationResult } = require("express-validator");
const { knex, T, nowEpoch } = require("../db/knex");
const { requireLogin } = require("../middleware/auth");
const permissions = require("../permissions");
const grants = require("../services/grants");
const devicesRepo = require("../db/repos/devices");
const credentials = require("../db/repos/credentials");
const deviceFlows = require("../services/deviceFlows");
const display = require("../services/display");
const settings = require("../config/settings");
const activity = require("../services/activity");

const router = express.Router();
// Malformed ids are a plain 404, never a 500 (middleware/account.js uidParam).
router.param("uid", require("../middleware/account").uidParam);
router.use(requireLogin);

// Device detail: resolves permissions at the device's location; denied = 404.
async function loadDevice(req, res, next)
{
    try
    {
        const device = await devicesRepo.findByUid(req.params.uid);
        const location = device ? await knex(T("locations")).where({ id: device.location_id }).first() : null;
        if (!device || !location) { return next(notFoundError()); }
        const bits = await grants.effectiveAtLocation(req, location);
        if (!permissions.has(bits, permissions.byName.view)) { return next(notFoundError()); }
        req.device = device; req.location = location; req.deviceBits = bits;
        require("../middleware/account").enterLocation(req, location);
        req.deviceType = await knex(T("device_types")).where({ id: device.device_type_id }).first();
        try { req.typeModule = req.deviceType ? require("../deviceTypes").get(req.deviceType.slug) : null; }
        catch (err) { req.typeModule = null; }
        next();
    }
    catch (err) { next(err); }
}

// Config shows only for unit hardware whose type declares configKeys.
function tabs(req, current)
{
    const base = "/devices/" + String(req.device.uid).toLowerCase();
    const list = [{ label: "Sensors", path: base }, { label: "Tags", path: base + "/tags" }];
    if (hasConfig(req)) { list.push({ label: "Config", path: base + "/config" }); }
    if (allowedCommands(req).length > 0) { list.push({ label: "Commands", path: base + "/commands" }); }
    list.push({ label: "Settings", path: base + "/settings" });
    return list.map((t) => ({ label: t.label, path: t.path, active: t.label === current }));
}

function hasConfig(req)
{
    return !!(req.typeModule && req.typeModule.configKeys && credentials.isUnitHardware(req.device));
}

// Commands the type declares that this user may send. Each names its own permission bit, so a
// view only user can Get data but not Reboot. Unit hardware only (it needs broker credentials).
function allowedCommands(req)
{
    const all = (req.typeModule && req.typeModule.commands) || {};
    if (!credentials.isUnitHardware(req.device)) { return []; }
    return Object.keys(all)
        .filter((name) =>
        {
            const bit = permissions.byName[all[name].permission || "edit"];
            return bit !== undefined && permissions.has(req.deviceBits, bit);
        })
        .map((name) => Object.assign({ name: name }, all[name]));
}

function trail(req)
{
    const locUid = String(req.location.uid).toLowerCase();
    return [
        { label: "Account", path: "/account" }, { label: req.location.name, path: "/locations/" + locUid },
        { label: req.device.kind === "gateway" ? "Gateways" : "Devices", path: "/locations/" + locUid + (req.device.kind === "gateway" ? "/gateways" : "/devices") },
        { label: req.device.name, path: "/devices/" + String(req.device.uid).toLowerCase(), isCurrent: true }
    ];
}

// Pod stations (services/stations.js). A controller's Sensors tab shows its station: the pairing
// toggle and banner, and the target pods paired with it. A target pod's shows its controller.
// null for every other device.
async function stationModel(req)
{
    const stations = require("../services/stations");
    if (req.typeModule && req.typeModule.station)
    {
        const cred = await credentials.forDevice(req.device);
        const pairing = await stations.pairingState(req.device);
        return {
            kind: "controller",
            pairing: pairing,
            // What the page asks for: a pending write wins over what the pod last reported.
            wanted: pairing.pending !== null ? pairing.pending : pairing.on,
            pods: await stations.roster(req.device.id),
            canPair: permissions.has(req.deviceBits, permissions.byName.edit) && !!cred && cred.state === "active",
            elsewhere: await stations.pairingElsewhere(req.device.location_id, req.device.id)
        };
    }
    if (req.device.controller_id)
    {
        return { kind: "pod", controller: await devicesRepo.findById(req.device.controller_id) };
    }
    return null;
}

router.get("/:uid", loadDevice, async (req, res, next) =>
{
    try
    {
        // Hidden sensors (DECISIONS "Sensor delete and hide") are listed only with ?hidden=1.
        const showHidden = req.query.hidden === "1";
        const allSensors = await knex(T("sensors")).where({ device_id: req.device.id }).whereNull("delete_epoch").orderBy("sort_order");
        const hiddenCount = allSensors.filter((s) => s.is_hidden).length;
        const sensors = showHidden ? allSensors : allSensors.filter((s) => !s.is_hidden);
        for (const s of sensors)
        {
            s.display = await display.format(s, s.last_value, req.location);
            // Sort value for the sensors table (iot-sort.js): the value in its display unit, as live.js sends it.
            s.sort_value = s.last_value === null || s.last_value === undefined ? "" : Number(require("../metrics").fromCanonical(s.metric, s.last_value, await display.resolveUnit(s, req.location)).toFixed(4));
            s.alarm = await knex(T("alarms")).where({ sensor_id: s.id }).whereNull("cleared_epoch").first();
            s.tags = await require("../services/tags").effectiveForSensor(s);
        }
        const cred = await credentials.forDevice(req.device);
        const coverage = req.device.kind === "gateway"
            ? await knex(T("device_coverage") + " as c").join(T("devices") + " as d", "d.id", "c.device_id").leftJoin(T("device_types") + " as dt", "dt.id", "d.device_type_id").where("c.gateway_id", req.device.id).whereNull("d.delete_epoch").select("c.*", "d.name", "d.uid", "dt.slug as type_slug").orderBy("c.last_heard_epoch", "desc")
            : await knex(T("device_coverage") + " as c").join(T("devices") + " as d", "d.id", "c.gateway_id").where("c.device_id", req.device.id).whereNull("d.delete_epoch").select("c.*", "d.name", "d.uid").orderBy("c.last_heard_epoch", "desc");
        // Signal percent of each coverage RSSI: the radio is the heard device's own type (its rssi
        // channel's signal: "ble" | "lora"), the same table the pipeline uses. null when the type
        // declares no radio, and the page then shows dBm as before.
        coverage.forEach((c) =>
        {
            const mod = req.device.kind === "gateway" ? require("../deviceTypes").all[c.type_slug] : req.typeModule;
            const ch = mod && (mod.channels || []).find((x) => x.id === "rssi" && x.signal);
            c.signal_pct = ch ? require("../services/levels").signalPercent(ch.signal, c.last_rssi) : null;
        });
        res.render("devices/show", { title: req.device.name, device: req.device, location: req.location, type: req.deviceType, sensors: sensors, cred: cred, awaiting: credentials.awaiting(req.device, cred), coverage: coverage, showHidden: showHidden, hiddenCount: hiddenCount, bits: req.deviceBits, permissions: permissions, navTrail: trail(req), navSub: tabs(req, "Sensors"), threshold: settings.get("ONLINE_THRESHOLD_SECS", 900), station: await stationModel(req) });
    }
    catch (err) { next(err); }
});

// Just the station panel, for the controller page's live refresh (a "config" socket notice for
// this device: pairing confirmed, or a target pod paired or moved).
router.get("/:uid/station", loadDevice, async (req, res, next) =>
{
    try
    {
        const station = await stationModel(req);
        if (!station || station.kind !== "controller") { return next(notFoundError()); }
        res.render("devices/station", { layout: false, device: req.device, location: req.location, station: station });
    }
    catch (err) { next(err); }
});

// Pairing mode on or off: the pair_mode config write (services/unitConfig), so the page shows what
// the controller actually holds. At most one controller per location may be pairing.
router.post("/:uid/pairing", loadDevice, need("edit"), async (req, res, next) =>
{
    try
    {
        if (!req.typeModule || !req.typeModule.station) { return next(notFoundError()); }
        const back = "/devices/" + req.params.uid;
        const stations = require("../services/stations");
        const on = req.body.action === "on";
        const cred = await credentials.forDevice(req.device);
        if (!cred || cred.state !== "active")
        {
            req.flash("warning", "This controller has no active broker credentials yet, so it cannot be put in pairing mode.");
            return res.redirect(back);
        }
        if (on)
        {
            const other = await stations.pairingElsewhere(req.device.location_id, req.device.id);
            if (other)
            {
                req.flash("warning", other.name + " at this location is already in pairing mode. Turn it off first; only one controller per location can pair at a time.");
                return res.redirect(back);
            }
        }
        const r = await require("../services/unitConfig").write(req.device.hardware_id, cred.broker_username, stations.PAIR_KEY, on ? "true" : "false", req.typeModule, req.user.id);
        if (!r.ok)
        {
            req.flash("danger", r.error);
            return res.redirect(back);
        }
        await activity.log(req, on ? "pairing_on" : "pairing_off", { entity_type: "device", entity_uid: req.device.uid });
        if (!r.sent) { req.flash("warning", "Saved. The broker is not reachable from this server right now; the controller gets it when it next connects."); }
        else { req.flash("success", on ? "Pairing mode sent to the controller." : "Pairing off sent to the controller."); }
        res.redirect(back);
    }
    catch (err) { next(err); }
});

router.get("/:uid/tags", loadDevice, async (req, res, next) =>
{
    try
    {
        const tagsSvc = require("../services/tags");
        const own = await tagsSvc.tagNames("device", req.device.id);
        const all = await knex(T("tags")).where({ account_id: req.location.account_id }).orderBy("name");
        res.render("devices/tags", { title: req.device.name, device: req.device, location: req.location, own: own, all: all, bits: req.deviceBits, permissions: permissions, navTrail: trail(req), navSub: tabs(req, "Tags") });
    }
    catch (err) { next(err); }
});

router.post("/:uid/tags", loadDevice, async (req, res, next) =>
{
    try
    {
        if (!permissions.has(req.deviceBits, permissions.byName.edit)) { return next(notFoundError()); }
        const tagsRepo = require("../db/repos/tags");
        const names = String(req.body.tags || "").split(",").map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 40);
        await knex.transaction(async (trx) =>
        {
            await trx(T("taggings")).where({ entity_type: "device", entity_id: req.device.id }).del();
            for (const n of names)
            {
                const id = await tagsRepo.getOrCreate(req.location.account_id, n, false, trx);
                await tagsRepo.tag("device", req.device.id, id, trx);
            }
        });
        req.flash("success", "Tags saved.");
        res.redirect("/devices/" + req.params.uid + "/tags");
    }
    catch (err) { next(err); }
});

router.get("/:uid/settings", loadDevice, async (req, res, next) =>
{
    try
    {
        const cred = await credentials.forDevice(req.device);
        const offline = await knex(T("offline_periods")).where({ device_id: req.device.id }).orderBy("start_epoch", "desc").limit(10);
        const reasons = await knex(T("list_items") + " as i").join(T("lists") + " as l", "l.id", "i.list_id").where("l.slug", "offline_reasons").orderBy("i.sort_order").select("i.label");
        const chemistryDefault = req.typeModule ? req.typeModule.batteryChemistry || null : null;
        res.render("devices/settings", { title: req.device.name, device: req.device, location: req.location, type: req.deviceType, cred: cred, chemistryDefault: chemistryDefault, chemistries: require("../services/levels").chemistries, unitHardware: credentials.isUnitHardware(req.device), offline: offline, reasons: reasons.map((r) => r.label), bits: req.deviceBits, permissions: permissions, navTrail: trail(req), navSub: tabs(req, "Settings") });
    }
    catch (err) { next(err); }
});

// Gateway config (services/unitConfig.js): what the unit reports, and writes waiting for it to
// confirm. Keyed by the unit's MAC, so it follows the hardware across placements.
router.get("/:uid/config", loadDevice, async (req, res, next) =>
{
    try
    {
        if (!hasConfig(req)) { return next(notFoundError()); }
        const cred = await credentials.forDevice(req.device);
        const rows = await require("../services/unitConfig").forPage(req.device.hardware_id, req.typeModule);
        res.render("devices/config", { title: req.device.name, device: req.device, location: req.location, cred: cred, rows: rows, now: nowEpoch(), bits: req.deviceBits, permissions: permissions, navTrail: trail(req), navSub: tabs(req, "Config") });
    }
    catch (err) { next(err); }
});

// Just the rows, for the config page's live refresh (a "config" socket notice carries no values).
// Same permission checks as the page, through loadDevice.
router.get("/:uid/config/rows", loadDevice, async (req, res, next) =>
{
    try
    {
        if (!hasConfig(req)) { return next(notFoundError()); }
        const cred = await credentials.forDevice(req.device);
        const rows = await require("../services/unitConfig").forPage(req.device.hardware_id, req.typeModule);
        res.render("devices/config-rows", { layout: false, device: req.device, location: req.location, cred: cred, rows: rows, bits: req.deviceBits, permissions: permissions });
    }
    catch (err) { next(err); }
});

router.post("/:uid/config", loadDevice, need("edit"), async (req, res, next) =>
{
    try
    {
        if (!hasConfig(req)) { return next(notFoundError()); }
        const back = "/devices/" + req.params.uid + "/config";
        const cred = await credentials.forDevice(req.device);
        if (!cred || cred.state !== "active")
        {
            req.flash("warning", "This unit has no active broker credentials yet, so it cannot be sent settings.");
            return res.redirect(back);
        }
        const unitConfig = require("../services/unitConfig");
        const key = String(req.body.key || "");
        if (req.body.cancel)
        {
            await unitConfig.cancel(req.device.hardware_id, key);
            await activity.log(req, "device_config_cancel", { entity_type: "device", entity_uid: req.device.uid, detail: key });
            req.flash("success", "Pending change to " + key + " cancelled. The gateway keeps whatever it already applied.");
            return res.redirect(back);
        }
        // Pairing mode from the Config tab keeps the one controller per location rule too.
        const stations = require("../services/stations");
        if (key === stations.PAIR_KEY && req.typeModule.station && stations.truthy(req.body.value))
        {
            const other = await stations.pairingElsewhere(req.device.location_id, req.device.id);
            if (other)
            {
                req.flash("warning", other.name + " at this location is already in pairing mode. Turn it off first; only one controller per location can pair at a time.");
                return res.redirect(back);
            }
        }
        const r = await unitConfig.write(req.device.hardware_id, cred.broker_username, key, req.body.value, req.typeModule, req.user.id);
        if (!r.ok)
        {
            req.flash("danger", key + ": " + r.error);
            return res.redirect(back);
        }
        await activity.log(req, "device_config_write", { entity_type: "device", entity_uid: req.device.uid, detail: key });
        req.flash("success", r.sent ? "Sent to the gateway. The value stays pending until the gateway confirms it." : "Saved as pending. The broker is not reachable from this server right now; it is sent when the gateway next connects.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

function need(bitName)
{
    return (req, res, next) =>
    {
        if (!permissions.has(req.deviceBits, permissions.byName[bitName])) { return next(notFoundError()); }
        next();
    };
}

// Form posts flash and redirect; JSON requests (the bulk bar) get { ok, message, state }.
function replier(req, res, back)
{
    const wantsJson = req.is("application/json") || (req.get("accept") || "").includes("application/json");
    const reply = (status, ok, message, extra) =>
    {
        if (wantsJson) { return res.status(status).json(Object.assign({ ok: ok, message: message }, extra || {})); }
        req.flash(ok ? "success" : (status === 409 ? "warning" : "danger"), message);
        return res.redirect(back);
    };
    reply.wantsJson = wantsJson;
    return reply;
}

// Commands tab: one button per command the user may send. Commands are not queued.
router.get("/:uid/commands", loadDevice, async (req, res, next) =>
{
    try
    {
        const commands = allowedCommands(req);
        if (commands.length === 0) { return next(notFoundError()); }
        const cred = await credentials.forDevice(req.device);
        res.render("devices/commands", { title: req.device.name, device: req.device, location: req.location, cred: cred, commands: commands, bits: req.deviceBits, permissions: permissions, navTrail: trail(req), navSub: tabs(req, "Commands") });
    }
    catch (err) { next(err); }
});

// Sends one command now through mqtt/downlink.js. A name the user may not send, or that the type
// does not declare, is a 404 like any denied action. Cooldowns are read from the activity log, so
// they hold across users and farm servers.
router.post("/:uid/commands", loadDevice, async (req, res, next) =>
{
    try
    {
        const back = "/devices/" + req.params.uid + "/commands";
        const name = String(req.body.command || "");
        const cmd = allowedCommands(req).find((c) => c.name === name);
        if (!cmd) { return next(notFoundError()); }
        const cred = await credentials.forDevice(req.device);
        if (!cred || cred.state !== "active")
        {
            req.flash("warning", "This unit has no active broker credentials yet, so it cannot be sent commands.");
            return res.redirect(back);
        }
        if (cmd.cooldownSecs)
        {
            const now = nowEpoch();
            const last = await require("../db/repos/events").lastEpoch("device_command", req.device.uid, name, now - cmd.cooldownSecs);
            if (last)
            {
                req.flash("warning", cmd.label + " was requested " + (now - last) + " seconds ago. Try again in " + (last + cmd.cooldownSecs - now) + " seconds.");
                return res.redirect(back);
            }
        }
        const topics = require("../mqtt/topics");
        const sent = await require("../mqtt/downlink").publish(topics.device.command(cred.broker_username, name), cmd.payload || "");
        if (!sent)
        {
            req.flash("danger", cmd.label + " not sent: this server has no broker connection right now. Try again shortly.");
            return res.redirect(back);
        }
        await activity.log(req, "device_command", { entity_type: "device", entity_uid: req.device.uid, detail: name });
        req.flash("success", cmd.label + " sent to the gateway.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

router.post("/:uid/rename", loadDevice, need("edit"), body("name").trim().isLength({ min: 1, max: 120 }), async (req, res, next) =>
{
    try
    {
        if (!validationResult(req).isEmpty()) { req.flash("danger", "Name is required."); return res.redirect("/devices/" + req.params.uid + "/settings"); }
        await deviceFlows.rename(req.device, req.body.name.trim(), req.user);
        req.flash("success", "Renamed.");
        res.redirect("/devices/" + req.params.uid + "/settings");
    }
    catch (err) { next(err); }
});

// Battery chemistry override (int-vbat-pct). Blank returns the device to its type's default. Only
// shown and accepted for types that declare a batteryChemistry.
router.post("/:uid/battery", loadDevice, need("edit"), async (req, res, next) =>
{
    try
    {
        const back = "/devices/" + req.params.uid + "/settings";
        if (!req.typeModule || !req.typeModule.batteryChemistry) { return next(notFoundError()); }
        const value = String(req.body.battery_chemistry || "");
        if (value !== "" && !require("../services/levels").BATTERY[value])
        {
            req.flash("danger", "Unknown battery type.");
            return res.redirect(back);
        }
        await knex(T("devices")).where({ id: req.device.id }).update({ battery_chemistry: value === "" ? null : value });
        await activity.log(req, "device_battery_chemistry", { entity_type: "device", entity_uid: req.device.uid, detail: value || "default" });
        req.flash("success", "Battery type saved. Battery percent uses it from the next reading.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

router.post("/:uid/reprovision", loadDevice, need("edit"), async (req, res, next) =>
{
    try
    {
        await deviceFlows.reprovision(req.device, req.user);
        await activity.log(req, "device_reprovision", { entity_type: "device", entity_uid: req.device.uid });
        req.flash("success", "Credentials reset. The gateway will re-provision on its next bootstrap connection.");
        res.redirect("/devices/" + req.params.uid + "/settings");
    }
    catch (err) { next(err); }
});

router.post("/:uid/archive", loadDevice, need("edit"), async (req, res, next) =>
{
    const reply = replier(req, res, "/devices/" + req.params.uid + "/settings");
    try
    {
        // The bulk bar only archives; a JSON request never toggles an archived device back.
        if (reply.wantsJson && req.device.is_archived) { return reply(409, false, "Already archived."); }
        if (req.device.is_archived) { await deviceFlows.unarchive(req.device, req.user); }
        else { await deviceFlows.archive(req.device, req.user); }
        await activity.log(req, req.device.is_archived ? "device_unarchived" : "device_archived", { entity_type: "device", entity_uid: req.device.uid });
        if (req.device.is_archived) { return reply(200, true, "Device restored.", { state: { archived: false } }); }
        return reply(200, true, "Device archived. Readings stay chartable; alarms stop.", { state: { archived: true } });
    }
    catch (err) { return reply(400, false, err.message); }
});

// Offline periods (architecture 8.3): manual on/off with a reason from the list and a comment.
router.post("/:uid/offline", loadDevice, need("set_offline"), async (req, res, next) =>
{
    const reply = replier(req, res, "/devices/" + req.params.uid + "/settings");
    try
    {
        const now = nowEpoch();
        let message = null;
        let state = null;
        if (req.body.action === "end")
        {
            await knex(T("offline_periods")).where({ device_id: req.device.id }).whereNull("end_epoch").update({ end_epoch: now });
            await knex(T("devices")).where({ id: req.device.id }).update({ is_offline: 0 });
            message = "Device back online. Alarm clocks start from zero."; state = { offline: false };
        }
        else
        {
            const comment = (req.body.comment || "").trim();
            if (!comment) { return reply(400, false, "A comment is required."); }
            if (reply.wantsJson && req.device.is_offline) { return reply(409, false, "Already offline."); }
            await knex(T("offline_periods")).insert({ device_id: req.device.id, start_epoch: now, end_epoch: null, reason: (req.body.reason || "Maintenance").slice(0, 120), comment: comment.slice(0, 500), created_by: req.user.id, created_epoch: now });
            await knex(T("devices")).where({ id: req.device.id }).update({ is_offline: 1 });
            await require("../services/alarms/engine").clearAllForDevice(req.device.id, now, "offline", { type: "user", id: req.user.id }, "cleared, device set offline");
            message = "Device marked offline. Readings still log; alarms are disarmed."; state = { offline: true };
        }
        await activity.log(req, "device_offline_" + (req.body.action === "end" ? "end" : "start"), { entity_type: "device", entity_uid: req.device.uid });
        if (!reply.wantsJson && state.offline) { req.flash("warning", message); return res.redirect("/devices/" + req.params.uid + "/settings"); }
        return reply(200, true, message, { state: state });
    }
    catch (err) { if (reply.wantsJson) { return res.status(500).json({ ok: false, message: "Internal error", reference: req.id }); } next(err); }
});

router.post("/:uid/delete", loadDevice, need("delete"), async (req, res, next) =>
{
    const back = "/locations/" + String(req.location.uid).toLowerCase() + (req.device.kind === "gateway" ? "/gateways" : "/devices");
    const reply = replier(req, res, back);
    try
    {
        await deviceFlows.softDelete(req.device, req.user);
        await activity.log(req, "device_deleted", { entity_type: "device", entity_uid: req.device.uid });
        return reply(200, true, req.device.name + " deleted.", { state: { deleted: true } });
    }
    catch (err) { if (reply.wantsJson) { return res.status(500).json({ ok: false, message: "Internal error", reference: req.id }); } next(err); }
});

module.exports = router;
