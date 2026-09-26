// Unclaimed devices (DECISIONS "Unclaimed devices, per account"): the account page, and render()
// for the location's Unclaimed view (routes/locations.js), which is this page filtered to one
// location. The row actions answer JSON for the bulk bar (public/js/iot-bulk.js).
const express = require("express");
const { knex, T } = require("../../db/knex");
const { notFoundError } = require("../../middleware/errors");
const permissions = require("../../permissions");
const grants = require("../../services/grants");
const activity = require("../../services/activity");
const unclaimed = require("../../services/unclaimed");
const deviceFlows = require("../../services/deviceFlows");
const deviceService = require("../../services/devices");

const router = express.Router();

// The account's locations the user can view, each with what the user may do there.
async function accountLocations(req, accountId)
{
    const visible = (await grants.visibleLocations(req)).filter((l) => l.account_id === accountId);
    for (const l of visible)
    {
        const b = await grants.effectiveAtLocation(req, l);
        l.canAdd = permissions.has(b, permissions.byName.add_device);
    }
    return visible;
}

// Shared by /account/unclaimed and /locations/:uid/unclaimed. filterLocation: a location row (the
// location view) or null (the account page, which may filter by ?location=uid).
async function render(req, res, account, filterLocation)
{
    const locations = await accountLocations(req, account.id);
    let filter = filterLocation;
    if (!filter && req.query.location)
    {
        filter = locations.find((l) => String(l.uid).toLowerCase() === String(req.query.location).toLowerCase()) || null;
    }
    const showIgnored = req.query.ignored === "1";
    const rows = await unclaimed.list({ accountId: account.id, locationIds: locations.map((l) => l.id), locationId: filter ? filter.id : null, showIgnored: showIgnored });
    const claimTargets = locations.filter((l) => l.canAdd && l.membership_mode !== "locked");
    res.render("account/unclaimed", {
        title: "Unclaimed devices",
        account: account,
        rows: rows,
        locations: locations,
        filter: filter,
        inLocation: !!filterLocation,
        showIgnored: showIgnored,
        claimTargets: claimTargets,
        canIgnore: locations.some((l) => l.canAdd)
    });
}

router.get("/unclaimed", async (req, res, next) =>
{
    try
    {
        await render(req, res, req.account, null);
    }
    catch (err) { next(err); }
});

// Row actions. The account comes from the body (the location view posts here with its own
// account uid in the URL and body), and must be one the user can see.
async function actionContext(req, res)
{
    const account = (res.locals.accounts || []).find((a) => String(a.uid).toLowerCase() === String(req.body.account || "").toLowerCase());
    if (!account) { return null; }
    const mac = deviceService.normalizeMac(req.params.mac || "");
    if (!/^[0-9A-F]{12}$/.test(mac)) { return null; }
    return { account: account, mac: mac, locations: await accountLocations(req, account.id) };
}
function reply(res, ok, message, state) { return res.json({ ok: ok, message: message, state: state || {} }); }

router.post("/unclaimed/:mac/claim", async (req, res, next) =>
{
    try
    {
        const c = await actionContext(req, res);
        if (!c) { return next(notFoundError()); }
        const target = c.locations.find((l) => String(l.uid).toLowerCase() === String(req.body.location || "").toLowerCase());
        if (!target || !target.canAdd) { return reply(res, false, "You cannot add devices at that location."); }
        if (target.membership_mode === "locked") { return reply(res, false, target.name + " is locked."); }
        const reg = await knex(T("device_registry")).where({ mac: c.mac }).first();
        const look = await deviceFlows.lookup(c.mac, req);
        const type = look.suggestedType || unclaimed.typeFor(reg, null);
        if (!type) { return reply(res, false, "Unknown device type; add it from the location's Devices page."); }
        const r = await deviceFlows.addByMac({ mac: c.mac, name: unclaimed.defaultName(type, c.mac), typeSlug: type.slug, location: target, deliberate: false }, req, req.user);
        await unclaimed.forget(c.mac);
        await activity.log(req, "device_claimed", { entity_type: "device", entity_uid: r.device.uid, detail: c.mac });
        return reply(res, true, r.device.name + " added to " + target.name + ".", { claimed: true, device: String(r.device.uid).toLowerCase(), location: target.name });
    }
    catch (err) { return reply(res, false, err.message); }
});

async function ignoreAction(req, res, next, ignore)
{
    try
    {
        const c = await actionContext(req, res);
        if (!c) { return next(notFoundError()); }
        if (!c.locations.some((l) => l.canAdd)) { return reply(res, false, "You need add device permission in this account."); }
        const changed = await unclaimed.setIgnored(c.account.id, c.mac, ignore, req.user);
        if (changed) { await activity.log(req, ignore ? "unclaimed_ignored" : "unclaimed_unignored", { entity_type: "unit", detail: c.mac + " account " + c.account.name }); }
        return reply(res, true, ignore ? "Ignored." : "Unignored.", { ignored: ignore });
    }
    catch (err) { return reply(res, false, err.message); }
}
router.post("/unclaimed/:mac/ignore", (req, res, next) => ignoreAction(req, res, next, true));
router.post("/unclaimed/:mac/unignore", (req, res, next) => ignoreAction(req, res, next, false));

module.exports = router;
module.exports.render = render;
