const express = require("express");
const { body, validationResult } = require("express-validator");
const settings = require("../config/settings");
const users = require("../db/repos/users");
const notifications = require("../db/repos/notifications");
const passwords = require("../services/passwords");
const activity = require("../services/activity");
const mail = require("../services/mail");
const { knex, T, nowEpoch } = require("../db/knex");
const { audit } = require("../services/audit");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();
router.use(requireLogin);

const TRAIL = [{ label: "Profile", path: "/profile", isCurrent: true }];

// Profile tabs: your details, and your support requests (DECISIONS.md "Support requests").
function tabs(current)
{
    return [["Details", "/profile"], ["Support", "/profile/support"]].map((t) => ({ label: t[0], path: t[1], active: t[1] === current }));
}

function usernameCooldownEnds(user)
{
    const days = settings.get("USERNAME_CHANGE_DAYS", 30);
    if (!user.username_changed_epoch || user.is_superadmin) { return 0; }
    return user.username_changed_epoch + days * 86400;
}

router.get("/", (req, res) =>
{
    res.render("profile/index",
    {
        title: "Profile", navTrail: TRAIL, navSub: tabs("/profile"), values: req.user, errors: {},
        usernameLockedUntil: usernameCooldownEnds(req.user), policy: passwords.describe()
    });
});

router.post("/",
    body("display_name").trim().isLength({ max: 80 }),
    body("email").trim().isEmail().isLength({ max: 254 }),
    body("username").trim().isLength({ min: 3, max: 40 }).matches(/^[^@\s]+$/),
    async (req, res, next) =>
    {
        try
        {
            const errors = {};
            const v = validationResult(req);
            if (!v.isEmpty()) { v.array().forEach((e) => { errors[e.path] = "Check this value."; }); }
            const email = req.body.email.trim().toLowerCase();
            const username = req.body.username.trim();
            const now = nowEpoch();
            const lockedUntil = usernameCooldownEnds(req.user);

            if (email !== req.user.email.toLowerCase())
            {
                const other = await users.findByLogin(email);
                if (other && other.id !== req.user.id) { errors.email = "That email is already in use."; }
            }
            if (username.toLowerCase() !== req.user.username.toLowerCase())
            {
                if (lockedUntil > now) { errors.username = "Username can be changed again after the cooldown."; }
                const other = await users.findByLogin(username.toLowerCase());
                if (other && other.id !== req.user.id) { errors.username = "That username is taken."; }
            }
            if (Object.keys(errors).length > 0)
            {
                return res.status(422).render("profile/index", { title: "Profile", navTrail: TRAIL, navSub: tabs("/profile"), values: Object.assign({}, req.user, req.body), errors: errors, usernameLockedUntil: lockedUntil, policy: passwords.describe() });
            }

            const patch =
            {
                display_name: req.body.display_name.trim() || null,
                email: email,
                email_enabled: req.body.email_enabled ? 1 : 0
                // SMS is hidden in this app: phone and sms_enabled are never taken from a form.
            };
            await knex.transaction(async (trx) =>
            {
                if (username !== req.user.username)
                {
                    patch.username = username;
                    patch.username_changed_epoch = now;
                    await trx(T("username_history")).insert({ user_id: req.user.id, old_username: req.user.username, changed_epoch: now });
                    await audit(trx, { entityType: "user", entityUid: req.user.uid, entityName: username, field: "username", oldValue: req.user.username, newValue: username, actorType: "user", actorId: req.user.id });
                }
                if (email !== req.user.email)
                {
                    await audit(trx, { entityType: "user", entityUid: req.user.uid, entityName: username, field: "email", oldValue: req.user.email, newValue: email, actorType: "user", actorId: req.user.id });
                }
                await users.update(req.user.id, patch, trx);
            });
            await activity.log(req, "profile_updated");
            req.flash("success", "Profile saved.");
            res.redirect("/profile");
        }
        catch (err) { next(err); }
    });

router.get("/support", async (req, res, next) =>
{
    try
    {
        const rows = await require("../services/support").listForUser(req.user.id);
        res.render("profile/support", { title: "Profile", navTrail: TRAIL.concat([{ label: "Support", path: "/profile/support", isCurrent: true }]), navSub: tabs("/profile/support"), rows: rows });
    }
    catch (err) { next(err); }
});

router.get("/password", (req, res) =>
{
    res.render("profile/password",
    {
        title: "Set password", navTrail: TRAIL.concat([{ label: "Password", path: "/profile/password", isCurrent: true }]),
        confined: !!(req.session.mustSetPassword || req.user.must_set_password), errors: {}, policy: passwords.describe()
    });
});

router.post("/password", async (req, res, next) =>
{
    try
    {
        const confined = !!(req.session.mustSetPassword || req.user.must_set_password);
        const errors = {};
        // A magic link login proves control of the mailbox, so no current password then.
        if (!confined && !(await passwords.verify(req.body.current || "", req.user.password_hash))) { errors.current = "Current password is incorrect."; }
        const pw = passwords.check(req.body.password);
        if (pw) { errors.password = pw; }
        if (req.body.password !== req.body.password2) { errors.password2 = "Passwords do not match."; }
        if (Object.keys(errors).length > 0)
        {
            return res.status(422).render("profile/password", { title: "Set password", navTrail: TRAIL, confined: confined, errors: errors, policy: passwords.describe() });
        }
        const now = nowEpoch();
        await users.update(req.user.id, { password_hash: await passwords.hash(req.body.password), password_changed_epoch: now, must_set_password: 0 });
        // Other sessions die on their next request (loginEpoch < password_changed_epoch); this one is refreshed.
        req.session.loginEpoch = now + 1;
        req.session.mustSetPassword = false;
        await activity.log(req, "password_changed");
        req.flash("success", "Password updated.");
        res.redirect("/dashboard");
    }
    catch (err) { next(err); }
});

// Field diagnostic for mail delivery; rate limited and logged.
router.post("/test-email", async (req, res, next) =>
{
    try
    {
        const recent = await notifications.countRecent("test", "user", req.user.id, nowEpoch() - 600);
        if (recent >= 3)
        {
            req.flash("warning", "Three test emails in ten minutes is the limit. Try again later.");
            return res.redirect("/profile");
        }
        const r = await mail.send(
        {
            kind: "test", to: req.user.email, recipientType: "user", recipientId: req.user.id,
            subject: settings.siteName() + " test email",
            text: "This is a test message from " + settings.siteName() + ". If you can read this, email delivery works.\n"
        });
        await activity.log(req, "test_email", { outcome: r.ok ? "ok" : "failed", detail: r.reason || null });
        if (r.ok) { req.flash("success", "Test email sent to " + req.user.email + " via " + mail.active().name + "."); }
        else { req.flash("danger", "Send failed: " + r.reason); }
        res.redirect("/profile");
    }
    catch (err) { next(err); }
});

module.exports = router;
