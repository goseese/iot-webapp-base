const express = require("express");
const { body, validationResult } = require("express-validator");
const { knex, T } = require("../../db/knex");
const { notFoundError } = require("../../middleware/errors");
const permissions = require("../../permissions");
const grants = require("../../services/grants");
const activity = require("../../services/activity");
const { bits } = require("./shared");

const router = express.Router();
const locationService = require("../../services/locations");
const accountService = require("../../services/accounts");

router.get("/", async (req, res, next) =>
{
    try
    {
        const locations = await knex(T("locations")).where({ account_id: req.account.id }).whereNull("delete_epoch").orderBy("name");
        const visible = await grants.visibleLocations(req);
        const mine = locations.filter((l) => visible.some((v) => v.id === l.id));
        // Column sums for the table footer, shown only when there is more than one location.
        const totals = { gateways: 0, devices: 0 };
        const counts = await locationService.deviceCounts(mine.map((l) => l.id));
        for (const l of mine)
        {
            l.counts = counts[l.id];
            totals.gateways += l.counts.gateways; totals.devices += l.counts.devices;
        }
        res.render("account/index", { title: req.account.name, locations: mine, totals: totals, bits: await bits(req), permissions: permissions });
    }
    catch (err) { next(err); }
});

router.get("/locations", async (req, res, next) =>
{
    try
    {
        const visible = await grants.visibleLocations(req);
        const locations = visible.filter((l) => l.account_id === req.account.id);
        for (const l of locations) { l.counts = await locationService.counts(l.id); }
        const b = await bits(req);
        res.render("account/locations", { title: "Locations", locations: locations, canAdd: permissions.has(b, permissions.byName.edit), canMute: permissions.has(b, permissions.byName.manage_alarms), permissions: permissions, errors: {}, values: {} });
    }
    catch (err) { next(err); }
});

router.post("/locations",
    body("name").trim().isLength({ min: 1, max: 120 }),
    body("iana_timezone").trim().isLength({ min: 1, max: 64 }),
    async (req, res, next) =>
    {
        try
        {
            const b = await bits(req);
            if (!permissions.has(b, permissions.byName.edit)) { return next(notFoundError()); }
            if (!validationResult(req).isEmpty()) { req.flash("danger", "Name and timezone are required."); return res.redirect(req.acctBase + "/locations"); }
            try { new Intl.DateTimeFormat("en-US", { timeZone: req.body.iana_timezone }); }
            catch (err) { req.flash("danger", "Unknown timezone " + req.body.iana_timezone + ". Use an IANA name like America/Chicago."); return res.redirect(req.acctBase + "/locations"); }
            const loc = await locationService.create(req.account.id, { name: req.body.name.trim(), iana_timezone: req.body.iana_timezone.trim() }, req.user);
            await activity.log(req, "location_created", { entity_type: "location", entity_uid: loc.uid });
            req.flash("success", "Location " + loc.name + " added.");
            res.redirect("/locations/" + String(loc.uid).toLowerCase());
        }
        catch (err) { next(err); }
    });

// Account kill switch and per location kill switch from the locations list (architecture 8.6 gate 1).
router.post("/mute", async (req, res, next) =>
{
    try
    {
        const b = await bits(req);
        if (!permissions.has(b, permissions.byName.manage_alarms)) { return next(notFoundError()); }
        const muted = req.body.muted === "1" ? 1 : 0;
        await accountService.update(req.account, { notifications_muted: muted }, req.user);
        await activity.log(req, muted ? "account_muted" : "account_unmuted", { entity_type: "account", entity_uid: req.account.uid });
        req.flash(muted ? "warning" : "success", muted ? "Notifications for this account are muted." : "Notifications for this account are on.");
        res.redirect(req.acctBase);
    }
    catch (err) { next(err); }
});


module.exports = router;
