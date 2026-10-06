// Support requests (DECISIONS.md "Support requests", services/support.js for the rules).
//   POST /support                  new request from the modal (multipart) -> JSON
//   GET  /support                  superadmins: every request, by filter
//   GET  /support/:uid             the request page (requester or support)
//   POST /support/:uid/reply       add to the thread (requester or support)
//   POST /support/:uid/status      close or reopen (support only)
//   GET  /support/:uid/files/:id   one attachment (requester or support)
// Account > Support is routes/account/support.js; Profile > Support is routes/profile.js.
// Anyone who is neither the requester nor support gets the same 404 as a missing request.
const express = require("express");
const multer = require("multer");
const { notFoundError } = require("../middleware/errors");
const { requireLogin } = require("../middleware/auth");
const { uidParam, intParam, useAccount } = require("../middleware/account");
const grants = require("../services/grants");
const support = require("../services/support");
const activity = require("../services/activity");
const logger = require("../config/logger");

const router = express.Router();
router.param("uid", uidParam);
router.param("fileId", intParam);

// Memory storage: files go straight into the database. Two files at most (file, screenshot).
// defParamCharset: file names sent without a charset are read as UTF-8 (multer defaults to latin1).
const upload = multer(
{
    storage: multer.memoryStorage(),
    limits: { fileSize: support.MAX_BYTES, files: 2, fields: 12 },
    defParamCharset: "utf8"
}).fields([{ name: "file", maxCount: 1 }, { name: "screenshot", maxCount: 1 }]);

function parseUpload(req, res, next)
{
    upload(req, res, (err) =>
    {
        if (!err) { return next(); }
        const message = err.code === "LIMIT_FILE_SIZE" ? "Files must be under " + (support.MAX_BYTES / 1048576) + " MB." : "The upload could not be read.";
        res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ ok: false, error: message });
    });
}

// The modal posts in the background, so a lost session answers JSON rather than the login page.
function requireLoginJson(req, res, next)
{
    if (!req.user) { return res.status(401).json({ ok: false, error: "You are signed out. Sign in again, then send the request." }); }
    next();
}

// Where the request was sent from. A location the user can see (and its account), else an account
// the user can see, else the user's only account, else neither. Unknown or unseen ids are ignored.
async function scopeOf(req, accountUid, locationUid)
{
    const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
    if (locationUid)
    {
        const loc = (await grants.visibleLocations(req)).find((l) => same(l.uid, locationUid));
        if (loc) { return { accountId: loc.account_id, locationId: loc.id }; }
    }
    const accounts = req.visibleAccounts || [];
    if (accountUid)
    {
        const a = accounts.find((x) => same(x.uid, accountUid));
        if (a) { return { accountId: a.id, locationId: null }; }
    }
    if (accounts.length === 1) { return { accountId: accounts[0].id, locationId: null }; }
    return { accountId: null, locationId: null };
}

// A JPEG starts FF D8 FF; anything else posted as the screenshot is dropped.
function isJpeg(buf)
{
    return !!buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

router.post("/support", requireLoginJson, parseUpload, async (req, res, next) =>
{
    try
    {
        const b = req.body || {};
        const description = String(b.description || "").replace(/\r\n?/g, "\n").trim();
        if (!description) { return res.status(422).json({ ok: false, error: "Please describe the problem." }); }
        if (description.length > support.MAX_DESCRIPTION) { return res.status(422).json({ ok: false, error: "The description is limited to " + support.MAX_DESCRIPTION + " characters." }); }

        const files = [];
        const file = req.files && req.files.file ? req.files.file[0] : null;
        if (file)
        {
            const type = support.fileType(file.originalname);
            if (!type)
            {
                return res.status(422).json({ ok: false, error: "That file type is not accepted. Attach a picture, PDF, text, log, CSV, Excel or Word file." });
            }
            files.push({ filename: file.originalname, contentType: type, data: file.buffer });
        }
        const shot = req.files && req.files.screenshot ? req.files.screenshot[0] : null;
        if (shot && isJpeg(shot.buffer)) { files.push({ filename: "screenshot.jpg", contentType: "image/jpeg", data: shot.buffer }); }
        else if (shot) { logger.warn({ reqId: req.id, bytes: shot.size }, "support: screenshot is not a JPEG, dropped"); }

        const scope = await scopeOf(req, b.accountUid, b.locationUid);
        const out = await support.create(
        {
            user: req.user,
            accountId: scope.accountId,
            locationId: scope.locationId,
            severity: b.severity,
            description: description,
            pageUrl: b.pageUrl,
            pageTitle: b.pageTitle,
            userAgent: req.get("user-agent"),
            viewport: b.viewport,
            requestId: req.id,
            copyMe: b.copyMe === "true",
            files: files
        });
        const r = out.request;
        await activity.log(req, "support_request_created", { entity_type: "support", entity_uid: r.uid, detail: r.ref + ", " + r.severity + (out.emailed ? "" : ", no email went out") });
        logger.info({ reqId: req.id, supportId: r.id, ref: r.ref }, "support request created");
        res.json({ ok: true, number: r.ref, link: "/support/" + String(r.uid).toLowerCase() });
    }
    catch (err) { next(err); }
});

router.use("/support", requireLogin);

// Superadmins: every request, newest activity first. Default filter: Open and answered.
router.get("/support", async (req, res, next) =>
{
    try
    {
        if (!req.user.is_superadmin) { return next(notFoundError()); }
        const filter = support.filterOf(req.query.status);
        res.render("support/list",
        {
            title: "Support requests",
            rows: await support.listAll(filter.key),
            filter: filter,
            base: "/support",
            showAccount: true,
            empty: "No requests here."
        });
    }
    catch (err) { next(err); }
});

// Loads the request for this viewer (requester or support) or answers not found.
async function load(req, res, next)
{
    try
    {
        const r = await support.forViewer(req.params.uid, req.user);
        if (!r) { return next(notFoundError()); }
        req.supportRequest = r;
        next();
    }
    catch (err) { next(err); }
}

router.get("/support/:uid", load, async (req, res, next) =>
{
    try
    {
        const r = req.supportRequest;
        const staff = await support.canHandle(req.user, r);
        const own = r.user_id === req.user.id;
        const crumb = { label: "Request " + r.ref, path: "/support/" + String(r.uid).toLowerCase(), isCurrent: true };
        // Breadcrumb by viewer: superadmin on someone else's request Support requests; a handler the
        // request's account / Support; the requester Profile / Support.
        let navTrail;
        if (req.user.is_superadmin && !own)
        {
            navTrail = [{ label: "Support requests", path: "/support" }, crumb];
        }
        else if (staff && !own && r.account_id && useAccount(req, r.account_id))
        {
            navTrail = [{ label: "Account", path: "/account" }, { label: "Support", path: req.acctBase + "/support" }, crumb];
        }
        else
        {
            navTrail = [{ label: "Profile", path: "/profile" }, { label: "Support", path: "/profile/support" }, crumb];
        }
        res.render("support/request",
        {
            title: "Support request " + r.ref,
            navTrail: navTrail,
            request: r,
            staff: staff,
            asStaff: staff && !own,
            superadmin: !!req.user.is_superadmin,
            messages: await support.messages(r.id),
            files: await support.attachments(r.id),
            recipients: req.user.is_superadmin ? await support.recipients(r.id) : null,
            pageLink: support.pageLink(r),
            max: support.MAX_DESCRIPTION
        });
    }
    catch (err) { next(err); }
});

router.post("/support/:uid/reply", load, async (req, res, next) =>
{
    try
    {
        const r = req.supportRequest;
        const back = "/support/" + String(r.uid).toLowerCase();
        // Support replying on their own request counts as the requester.
        const isStaff = r.user_id !== req.user.id && await support.canHandle(req.user, r);
        const out = await support.reply(r, req.user, isStaff, req.body.body);
        if (out.error)
        {
            req.flash("danger", out.error);
            return res.redirect(back);
        }
        await activity.log(req, "support_reply", { entity_type: "support", entity_uid: r.uid, detail: r.ref + (isStaff ? ", from support" : ", from the requester") });
        req.flash("success", isStaff
            ? (out.requesterEmailed ? "Reply saved. The requester was emailed a link." : "Reply saved. The requester could not be emailed; they see it on this page.")
            : "Reply sent to support.");
        res.redirect(back);
    }
    catch (err) { next(err); }
});

router.post("/support/:uid/status", load, async (req, res, next) =>
{
    try
    {
        const r = req.supportRequest;
        if (!await support.canHandle(req.user, r)) { return next(notFoundError()); }
        const action = req.body.action === "close" ? "close" : (req.body.action === "reopen" ? "reopen" : null);
        if (!action) { return next(notFoundError()); }
        await support.setStatus(r, action, req.user);
        await activity.log(req, action === "close" ? "support_closed" : "support_reopened", { entity_type: "support", entity_uid: r.uid, detail: r.ref });
        req.flash("success", action === "close" ? "Request closed." : "Request reopened for support.");
        res.redirect("/support/" + String(r.uid).toLowerCase());
    }
    catch (err) { next(err); }
});

// RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name.
function disposition(type, filename)
{
    const ascii = String(filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return type + "; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(filename);
}

router.get("/support/:uid/files/:fileId", load, async (req, res, next) =>
{
    try
    {
        const f = await support.attachment(req.supportRequest.id, Number(req.params.fileId));
        if (!f) { return next(notFoundError()); }
        res.set("Content-Type", f.content_type);
        res.set("Content-Disposition", disposition(support.isInline(f.content_type) ? "inline" : "attachment", f.filename));
        res.set("Cache-Control", "private, max-age=3600");
        res.send(f.data);
    }
    catch (err) { next(err); }
});

module.exports = router;
