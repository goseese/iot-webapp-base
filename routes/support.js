// Support (DECISIONS.md "Support requests"): /help to read the intro and open a request, /support
// for superadmins (every request, by status), /support/<uid> for one conversation. A conversation
// is visible to its requester and to superadmins only; anyone else gets the same 404 as a missing
// request.
const express = require("express");
const { notFoundError } = require("../middleware/errors");
const { requireLogin } = require("../middleware/auth");
const { uidParam } = require("../middleware/account");
const support = require("../services/support");
const activity = require("../services/activity");

const router = express.Router();
router.param("uid", uidParam);
router.use(["/help", "/support"], requireLogin);

const STATUSES = ["open", "waiting", "closed", "all"];

async function helpPage(req, res, values, error)
{
    res.render("support/help",
    {
        title: "Help",
        mine: await support.listForUser(req.user.id),
        accounts: req.visibleAccounts || [],
        values: values || {},
        error: error || null,
        max: { subject: support.MAX_SUBJECT, body: support.MAX_BODY }
    });
}

router.get("/help", async (req, res, next) =>
{
    try { await helpPage(req, res); }
    catch (err) { next(err); }
});

router.post("/help", async (req, res, next) =>
{
    try
    {
        // The account is optional; only one the requester can see is accepted.
        const accounts = req.visibleAccounts || [];
        let accountId = null;
        if (accounts.length === 1) { accountId = accounts[0].id; }
        else if (/^\d+$/.test(String(req.body.account_id || "")))
        {
            const a = accounts.find((x) => x.id === Number(req.body.account_id));
            accountId = a ? a.id : null;
        }
        const r = await support.create(req.user, { subject: req.body.subject, body: req.body.body, accountId: accountId });
        if (r.error)
        {
            res.status(422);
            return helpPage(req, res, req.body, r.error);
        }
        await activity.log(req, "support_request_created", { entity_type: "support", entity_uid: r.request.uid, detail: r.request.subject });
        req.flash("success", "Your request was sent. You will get an email when support replies, and you can follow it here or on your profile's Support tab.");
        res.redirect("/support/" + String(r.request.uid).toLowerCase());
    }
    catch (err) { next(err); }
});

// Superadmins: every request, newest activity first. Default: the ones that need an answer.
router.get("/support", async (req, res, next) =>
{
    try
    {
        if (!req.user.is_superadmin) { return next(notFoundError()); }
        const status = STATUSES.includes(req.query.status) ? req.query.status : "open";
        const navSub = [["open", "Needs answer"], ["waiting", "Waiting on requester"], ["closed", "Closed"], ["all", "All"]]
            .map((t) => ({ label: t[1], path: "/support" + (t[0] === "open" ? "" : "?status=" + t[0]), active: t[0] === status }));
        res.render("support/list", { title: "Support requests", rows: await support.listAll(status), status: status, navSub: navSub });
    }
    catch (err) { next(err); }
});

async function loadRequest(req, res, next)
{
    try
    {
        const r = await support.byUid(req.params.uid);
        if (!support.canSee(r, req.user)) { return next(notFoundError()); }
        req.supportRequest = r;
        next();
    }
    catch (err) { next(err); }
}

router.get("/support/:uid", loadRequest, async (req, res, next) =>
{
    try
    {
        const r = req.supportRequest;
        const ctx = await support.context(r);
        res.render("support/thread",
        {
            title: r.subject,
            request: r,
            messages: await support.messages(r.id),
            requester: ctx.requester,
            account: ctx.account,
            asSupport: support.isSupportReply(r, req.user),
            max: support.MAX_BODY
        });
    }
    catch (err) { next(err); }
});

router.post("/support/:uid", loadRequest, async (req, res, next) =>
{
    try
    {
        const r = req.supportRequest;
        const back = "/support/" + String(r.uid).toLowerCase();
        if (req.body.action === "close" || req.body.action === "reopen")
        {
            if (!req.user.is_superadmin) { return next(notFoundError()); }
            await support.setStatus(r, req.body.action);
            await activity.log(req, req.body.action === "close" ? "support_closed" : "support_reopened", { entity_type: "support", entity_uid: r.uid });
            req.flash("success", req.body.action === "close" ? "Request closed." : "Request reopened.");
            return res.redirect(back);
        }
        const out = await support.reply(r, req.user, req.body.body);
        if (out.error)
        {
            req.flash("danger", out.error);
            return res.redirect(back);
        }
        await activity.log(req, "support_reply", { entity_type: "support", entity_uid: r.uid, detail: out.fromSupport ? "from support" : "from requester" });
        req.flash("success", out.fromSupport ? "Reply sent to the requester." : "Reply sent to support.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

module.exports = router;
