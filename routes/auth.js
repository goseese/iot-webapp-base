// Login, logout, forgot password, reset link, invite acceptance. Routes validate, call
// services and render; no SQL here.
const express = require("express");
const { body, validationResult } = require("express-validator");
const env = require("../config/env");
const settings = require("../config/settings");
const users = require("../db/repos/users");
const passwords = require("../services/passwords");
const tokens = require("../services/tokens");
const activity = require("../services/activity");
const mail = require("../services/mail");
const invites = require("../services/invites");
const { nowEpoch } = require("../db/knex");

const router = express.Router();
const AUTH = { layout: "layouts/auth" };

function startSession(req, user, opts)
{
    return new Promise((resolve, reject) =>
    {
        req.session.regenerate((err) =>
        {
            if (err) { return reject(err); }
            req.session.userId = user.id;
            req.session.loginEpoch = nowEpoch();
            req.session.mustSetPassword = !!(opts && opts.mustSetPassword);
            resolve();
        });
    });
}

router.get("/login", (req, res) =>
{
    if (req.user) { return res.redirect("/account"); }
    res.render("auth/login", Object.assign({ title: "Sign in", values: {}, error: null }, AUTH));
});

router.post("/login",
    body("login").trim().isLength({ min: 1, max: 254 }),
    body("password").isLength({ min: 1, max: 200 }),
    async (req, res, next) =>
    {
        try
        {
            const login = (req.body.login || "").trim().toLowerCase();
            const fail = async (why) =>
            {
                await activity.log(req, "login_failed", { actor_type: "anonymous", actor_name: login.slice(0, 80), outcome: "denied", detail: why });
                res.status(401).render("auth/login", Object.assign({ title: "Sign in", values: { login: req.body.login }, error: "Username or password is incorrect." }, AUTH));
            };
            if (!validationResult(req).isEmpty()) { return fail("validation"); }
            if (await activity.loginLocked(login, req.ip))
            {
                return res.status(429).render("auth/login", Object.assign({ title: "Sign in", values: { login: req.body.login }, error: "Too many failed attempts. Try again in " + settings.get("LOGIN_WINDOW_MINUTES", 15) + " minutes." }, AUTH));
            }
            const user = await users.findByLogin(login);
            if (!user || !(await passwords.verify(req.body.password, user.password_hash))) { return fail("bad credentials"); }

            await startSession(req, user, { mustSetPassword: !!user.must_set_password });
            await users.update(user.id, { last_login_epoch: nowEpoch() });
            req.user = user;
            await activity.log(req, "login");
            const to = req.session.returnTo || "/account";
            delete req.session.returnTo;
            res.redirect(user.must_set_password ? "/profile/password" : to);
        }
        catch (err) { next(err); }
    });

router.post("/logout", (req, res) =>
{
    activity.log(req, "logout");
    req.session.destroy(() => res.redirect("/login"));
});

router.get("/forgot-password", (req, res) =>
{
    res.render("auth/forgot", Object.assign({ title: "Reset password", sent: false }, AUTH));
});

// Enumeration safe: the page says the same thing whether or not the address exists.
router.post("/forgot-password", body("login").trim().isLength({ min: 1, max: 254 }), async (req, res, next) =>
{
    try
    {
        const login = (req.body.login || "").trim().toLowerCase();
        const user = login ? await users.findByLogin(login) : null;
        if (user)
        {
            const minutes = settings.get("RESET_LINK_MINUTES", 60);
            const token = await tokens.issue("password_reset", "user", user.id, minutes * 60);
            await mail.send(
            {
                kind: "reset", to: user.email, recipientType: "user", recipientId: user.id,
                subject: settings.siteName() + " password reset",
                text: "Use this link to sign in and set a new password:\n\n" + env.appUrl + "/reset/" + token +
                      "\n\nIt expires in " + minutes + " minutes. If you did not ask for this, ignore this message.\n"
            });
        }
        await activity.log(req, "password_reset_requested", { actor_name: login.slice(0, 80) });
        res.render("auth/forgot", Object.assign({ title: "Reset password", sent: true }, AUTH));
    }
    catch (err) { next(err); }
});

// Dead reset link: a friendly page that never says why, and the reason in the activity log.
async function resetLinkDead(req, res, row)
{
    const reason = row ? "account deleted" : await tokens.deadReason("password_reset", req.params.token);
    await activity.log(req, "password_reset_link_invalid",
    {
        actor_name: row ? "user " + row.subject_id : null, outcome: "denied", detail: reason
    });
    res.status(410).render("auth/link-dead", Object.assign({ title: "This reset link has expired", kind: "reset" }, AUTH));
}

// A signed in visitor never gets the confirm button; the token is left untouched so the link
// still works after signing out.
function resetWhileSignedIn(req, res)
{
    res.render("auth/reset-signed-in", Object.assign({ title: "You are already signed in", username: req.user.username }, AUTH));
}

// Opening a reset link changes nothing: mail scanners follow links, so the token is only
// consumed by the confirm button's POST (DECISIONS.md, reset links).
router.get("/reset/:token", async (req, res, next) =>
{
    try
    {
        if (req.user) { return resetWhileSignedIn(req, res); }
        const row = await tokens.peek("password_reset", req.params.token);
        const user = row ? await users.findById(row.subject_id) : null;
        if (!user || user.delete_epoch !== null) { return resetLinkDead(req, res, row); }
        res.render("auth/reset-confirm", Object.assign({ title: "Reset password", token: req.params.token, user: { username: user.username } }, AUTH));
    }
    catch (err) { next(err); }
});

// The confirm button logs the user in confined to the set password page (architecture 4.2).
router.post("/reset/:token", async (req, res, next) =>
{
    try
    {
        if (req.user) { return resetWhileSignedIn(req, res); }
        const row = await tokens.consume("password_reset", req.params.token);
        const user = row ? await users.findById(row.subject_id) : null;
        if (!user || user.delete_epoch !== null) { return resetLinkDead(req, res, row); }
        await startSession(req, user, { mustSetPassword: true });
        req.user = user;
        await activity.log(req, "login_via_reset_link");
        req.flash("info", "Set a new password to continue.");
        res.redirect("/profile/password");
    }
    catch (err) { next(err); }
});

router.get("/invite/:token", async (req, res, next) =>
{
    try
    {
        const inv = await invites.findValid(req.params.token);
        if (!inv) { return res.status(410).render("auth/link-dead", Object.assign({ title: "Invitation expired" }, AUTH)); }
        res.render("auth/invite", Object.assign({ title: "Accept invitation", invite: Object.assign({ token: req.params.token }, inv), values: { username: inv.username }, errors: {}, policy: passwords.describe() }, AUTH));
    }
    catch (err) { next(err); }
});

router.post("/invite/:token",
    body("username").trim().isLength({ min: 3, max: 40 }).matches(/^[^@\s]+$/),
    body("password").isLength({ min: 1, max: 200 }),
    async (req, res, next) =>
    {
        try
        {
            const inv = await invites.findValid(req.params.token);
            if (!inv) { return res.status(410).render("auth/link-dead", Object.assign({ title: "Invitation expired" }, AUTH)); }
            const errors = {};
            if (!validationResult(req).isEmpty()) { errors.username = "3 to 40 characters, no spaces or @."; }
            const pw = passwords.check(req.body.password);
            if (pw) { errors.password = pw; }
            if (req.body.password !== req.body.password2) { errors.password2 = "Passwords do not match."; }
            const username = (req.body.username || "").trim();
            if (!errors.username && await users.findByLogin(username.toLowerCase())) { errors.username = "That username is taken. Pick another."; }
            if (Object.keys(errors).length > 0)
            {
                return res.status(422).render("auth/invite", Object.assign({ title: "Accept invitation", invite: Object.assign({ token: req.params.token }, inv), values: { username: username }, errors: errors, policy: passwords.describe() }, AUTH));
            }
            const userId = await invites.accept(inv, username, await passwords.hash(req.body.password));
            const user = await users.findById(userId);
            await startSession(req, user, {});
            req.user = user;
            await activity.log(req, "invite_accepted");
            req.flash("success", "Welcome. Your account is ready.");
            res.redirect("/account");
        }
        catch (err) { next(err); }
    });

module.exports = router;
