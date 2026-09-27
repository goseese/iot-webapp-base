// Athletes and wristbands of an account (DECISIONS.md "Athletes and wristbands",
// services/athletes.js). Anyone with View at the account sees them; changes need Manage athletes.
const express = require("express");
const { knex, T } = require("../../db/knex");
const { notFoundError } = require("../../middleware/errors");
const { uidParam } = require("../../middleware/account");
const permissions = require("../../permissions");
const activity = require("../../services/activity");
const athletes = require("../../services/athletes");
const { bits } = require("./shared");

const router = express.Router({ mergeParams: true });
router.param("athleteUid", uidParam);
router.param("bandUid", uidParam);

async function access(req)
{
    const b = await bits(req);
    return { view: permissions.has(b, permissions.byName.view), manage: permissions.has(b, permissions.byName.manage_athletes) };
}

function viewOnly(req, res, next)
{
    access(req).then((a) => { if (!a.view) { return next(notFoundError()); } req.athleteAccess = a; next(); }).catch(next);
}

function manageOnly(req, res, next)
{
    access(req).then((a) => { if (!a.manage) { return next(notFoundError()); } req.athleteAccess = a; next(); }).catch(next);
}

async function loadAthlete(req, res, next)
{
    try
    {
        const a = await knex(T("athletes")).where({ uid: req.params.athleteUid, account_id: req.account.id }).first();
        if (!a) { return next(notFoundError()); }
        req.athlete = a;
        next();
    }
    catch (err) { next(err); }
}

async function loadBand(req, res, next)
{
    try
    {
        const b = await knex(T("wristbands")).where({ uid: req.params.bandUid, account_id: req.account.id }).first();
        if (!b) { return next(notFoundError()); }
        req.band = b;
        next();
    }
    catch (err) { next(err); }
}

// Times on these pages: the account has no timezone of its own, so its first location's.
async function tzOf(accountId)
{
    const l = await knex(T("locations")).where({ account_id: accountId }).whereNull("delete_epoch").orderBy("id").first();
    return l ? l.iana_timezone : "UTC";
}

// A form posted from another page (a pod's enrollment panel) returns there; anything else here.
function backTo(req, fallback)
{
    const b = String(req.body.back || "");
    return /^\/devices\/[0-9a-f-]{36}$/.test(b) ? b : fallback;
}

router.get("/athletes", viewOnly, async (req, res, next) =>
{
    try
    {
        res.render("account/athletes", { title: "Athletes", rows: await athletes.athletesForAccount(req.account.id), canManage: req.athleteAccess.manage, now: Math.floor(Date.now() / 1000) });
    }
    catch (err) { next(err); }
});

router.post("/athletes", manageOnly, async (req, res, next) =>
{
    try
    {
        if (!athletes.cleanName(req.body.name)) { req.flash("danger", "A name of 1 to 80 characters is required."); return res.redirect(req.acctBase + "/athletes"); }
        const a = await athletes.createAthlete(req.account.id, req.body.name, req.user);
        await activity.log(req, "athlete_created", { entity_type: "athlete", entity_uid: a.uid, detail: a.slug });
        req.flash("success", a.display_name + " added (" + a.slug + ").");
        res.redirect(req.acctBase + "/athletes/" + String(a.uid).toLowerCase());
    }
    catch (err) { next(err); }
});

router.get("/athletes/:athleteUid", viewOnly, loadAthlete, async (req, res, next) =>
{
    try
    {
        const d = await athletes.athleteDetail(req.athlete);
        res.render("account/athlete", {
            title: req.athlete.display_name, athlete: req.athlete, detail: d, canManage: req.athleteAccess.manage,
            loans: athletes.LOAN_LABELS, now: Math.floor(Date.now() / 1000), tz: await tzOf(req.account.id),
            navTrail: [{ label: "Account", path: "/account" }, { label: "Athletes", path: req.acctBase + "/athletes" }, { label: req.athlete.display_name, path: req.acctBase + "/athletes/" + String(req.athlete.uid).toLowerCase(), isCurrent: true }]
        });
    }
    catch (err) { next(err); }
});

router.post("/athletes/:athleteUid/rename", manageOnly, loadAthlete, async (req, res, next) =>
{
    try
    {
        const back = backTo(req, req.acctBase + "/athletes/" + String(req.athlete.uid).toLowerCase());
        const r = await athletes.rename(req.athlete, req.body.name, req.user);
        if (!r.ok) { req.flash("danger", r.error); return res.redirect(back); }
        await activity.log(req, "athlete_renamed", { entity_type: "athlete", entity_uid: req.athlete.uid });
        req.flash("success", "Name saved.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

router.post("/athletes/:athleteUid/assign", manageOnly, loadAthlete, async (req, res, next) =>
{
    try
    {
        const back = req.acctBase + "/athletes/" + String(req.athlete.uid).toLowerCase();
        const uid = String(req.body.band || "");
        const band = require("../../middleware/account").isUuid(uid) ? await knex(T("wristbands")).where({ uid: uid, account_id: req.account.id }).first() : null;
        if (!band) { req.flash("danger", "Choose a band."); return res.redirect(back); }
        const r = await athletes.assign(band, req.athlete, String(req.body.loan || "permanent"), req.user);
        if (!r.ok) { req.flash("danger", r.error); return res.redirect(back); }
        await activity.log(req, "band_assigned", { entity_type: "athlete", entity_uid: req.athlete.uid, detail: band.band_mac });
        req.flash("success", "Band " + (band.label || band.band_mac) + " given to " + req.athlete.display_name + ".");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

router.get("/wristbands", viewOnly, async (req, res, next) =>
{
    try
    {
        res.render("account/wristbands", { title: "Wristbands", rows: await athletes.bandsForAccount(req.account.id), canManage: req.athleteAccess.manage, now: Math.floor(Date.now() / 1000), tz: await tzOf(req.account.id) });
    }
    catch (err) { next(err); }
});

router.post("/wristbands", manageOnly, async (req, res, next) =>
{
    try
    {
        const r = await athletes.addBand(req.account.id, req.body.band_mac, req.body.label, req.user);
        if (!r.ok) { req.flash("danger", r.error); return res.redirect(req.acctBase + "/wristbands"); }
        await activity.log(req, "band_added", { entity_type: "wristband", entity_uid: r.band.uid, detail: r.band.band_mac });
        req.flash("success", "Band " + (r.band.label || r.band.band_mac) + " added.");
        res.redirect(req.acctBase + "/wristbands");
    }
    catch (err) { next(err); }
});

// status: returned (back from its athlete), lost, retired, active (found again).
router.post("/wristbands/:bandUid/status", manageOnly, loadBand, async (req, res, next) =>
{
    try
    {
        const back = /^\/account\/[0-9a-f-]{36}\/athletes\/[0-9a-f-]{36}$/.test(String(req.body.back || "")) ? req.body.back : req.acctBase + "/wristbands";
        const status = String(req.body.status || "");
        const r = await athletes.setStatus(req.band, status, req.user);
        if (!r.ok) { req.flash("danger", r.error); return res.redirect(back); }
        await activity.log(req, "band_" + status, { entity_type: "wristband", entity_uid: req.band.uid, detail: req.band.band_mac });
        req.flash("success", "Band " + (req.band.label || req.band.band_mac) + (status === "returned" ? " returned." : " marked " + status + "."));
        res.redirect(back);
    }
    catch (err) { next(err); }
});

router.post("/wristbands/:bandUid/label", manageOnly, loadBand, async (req, res, next) =>
{
    try
    {
        await athletes.relabel(req.band, req.body.label, req.user);
        req.flash("success", "Label saved.");
        res.redirect(req.acctBase + "/wristbands");
    }
    catch (err) { next(err); }
});

module.exports = router;
