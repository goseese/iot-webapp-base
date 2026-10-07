// Login, logout, forgot password, reset link, invite acceptance. Routes validate, call
// services and render; no SQL here.
const express = require("express");
const { body, validationResult } = require("express-validator");
const settings = require("../config/settings");
const users = require("../db/repos/users");
const passwords = require("../services/passwords");
const tokens = require("../services/tokens");
const activity = require("../services/activity");
const invites = require("../services/invites");
const mfa = require("../services/mfa");
const { nowEpoch } = require("../db/knex");

const router = express.Router();
const AUTH = { layout: "layouts/auth" };
// Administration > Users can put a user offline (users.disabled_epoch). Said only after a correct
// password or inside a pending sign in, so it tells nobody who does not hold the password.
const OFFLINE_MESSAGE = "This account is turned off. Contact your administrator.";

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

function renderLogin(req, res, status, login, error)
{
    res.status(status).render("auth/login", Object.assign({ title: "Sign in", values: { login: login || "" }, error: error, mfa: null }, AUTH));
}

// The login page with the sign in code modal open over it (DECISIONS.md "MFA sign in codes").
function renderCode(req, res, status, error, info)
{
    const p = req.session.mfa;
    res.status(status).render("auth/login", Object.assign({ title: "Sign in", values: { login: p.login }, error: null, mfa: { sentTo: p.sentTo, error: error, info: info } }, AUTH));
}

// Event log detail for a code send: the channel, whether SMS fell back to email, and why it failed.
function sendDetail(prefix, sent)
{
    return (prefix + " " + sent.channel + (sent.smsFellBack ? ", sms fell back to email" : "") + (sent.reason ? ": " + sent.reason : "")).trim();
}

function mfaActor(user)
{
    return { actor_type: "user", actor_id: user.id, actor_name: user.username };
}

// Starts the session exactly as every password login does. returnTo is read by the caller before
// this runs: regenerate() destroys the session and creates an empty one
// (express-session/session/store.js), so anything read from it afterwards is gone.
async function finishLogin(req, res, user, returnTo, detail)
{
    await startSession(req, user, { mustSetPassword: !!user.must_set_password });
    await users.update(user.id, { last_login_epoch: nowEpoch() });
    req.user = user;
    await activity.log(req, "login", detail ? { detail: detail } : {});
    res.redirect(user.must_set_password ? "/profile/password" : (returnTo || "/account"));
}

// Opening the login page drops any pending sign in; that is the code modal's Cancel.
router.get("/login", (req, res) =>
{
    if (req.user) { return res.redirect("/account"); }
    delete req.session.mfa;
    res.render("auth/login", Object.assign({ title: "Sign in", values: {}, error: null, mfa: null }, AUTH));
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
                res.status(401).render("auth/login", Object.assign({ title: "Sign in", values: { login: req.body.login }, error: "Username or password is incorrect.", mfa: null }, AUTH));
            };
            if (!validationResult(req).isEmpty()) { return fail("validation"); }
            if (await activity.loginLocked(login, req.ip))
            {
                return res.status(429).render("auth/login", Object.assign({ title: "Sign in", values: { login: req.body.login }, error: "Too many failed attempts. Try again in " + settings.get("LOGIN_WINDOW_MINUTES", 15) + " minutes.", mfa: null }, AUTH));
            }
            const user = await users.findByLogin(login);
            if (!user || !(await passwords.verify(req.body.password, user.password_hash))) { return fail("bad credentials"); }
            if (user.disabled_epoch)
            {
                await activity.log(req, "login_refused", Object.assign(mfaActor(user), { outcome: "denied", detail: "user offline" }));
                return renderLogin(req, res, 403, req.body.login, OFFLINE_MESSAGE);
            }

            const returnTo = req.session.returnTo || null;
            if (mfa.required(user))
            {
                // The user id is not in the session until the code passes, so every other page
                // still treats this visitor as signed out.
                const started = await mfa.begin(user, login.slice(0, 80), returnTo);
                if (!started.ok)
                {
                    await activity.log(req, "mfa_send_failed", Object.assign(mfaActor(user), { outcome: "failed", detail: sendDetail("", started.sent) }));
                    return renderLogin(req, res, 503, req.body.login, "We could not send your sign in code. Try again in a few minutes.");
                }
                req.session.mfa = started.pending;
                await activity.log(req, "mfa_sent", Object.assign(mfaActor(user), { detail: sendDetail("", started.sent) }));
                return res.redirect(303, "/login/mfa");
            }
            await finishLogin(req, res, user, returnTo, null);
        }
        catch (err) { next(err); }
    });

router.get("/login/mfa", (req, res) =>
{
    if (req.user) { return res.redirect("/account"); }
    const p = req.session.mfa;
    if (!p) { return res.redirect("/login"); }
    const info = p.notice || null;
    delete p.notice;
    renderCode(req, res, 200, null, info);
});

// The form field is mfa_token so the event log's redaction (any name with "token") never stores it.
router.post("/login/mfa", async (req, res, next) =>
{
    try
    {
        if (req.user) { return res.redirect("/account"); }
        const p = req.session.mfa;
        if (!p) { return res.redirect("/login"); }
        const user = await users.findById(p.userId);
        if (!user || user.delete_epoch !== null) { delete req.session.mfa; return res.redirect("/login"); }
        if (user.disabled_epoch) { delete req.session.mfa; return renderLogin(req, res, 403, p.login, OFFLINE_MESSAGE); }
        if (await activity.loginLocked(p.login, req.ip))
        {
            delete req.session.mfa;
            return renderLogin(req, res, 429, p.login, "Too many failed attempts. Try again in " + settings.get("LOGIN_WINDOW_MINUTES", 15) + " minutes.");
        }
        const r = mfa.check(p, String(req.body.mfa_token || "").slice(0, 40));
        if (r.result === "ok") { return finishLogin(req, res, user, p.returnTo, "with " + p.channel + " code"); }

        // A failed code is a failed login under the name typed at the password step, so the
        // lockout counts it and a stolen password cannot keep cycling through fresh codes.
        await activity.log(req, "login_failed", { actor_type: "anonymous", actor_name: p.login, outcome: "denied", detail: "sign in code " + r.result });
        if (r.result === "wrong")
        {
            req.session.mfa = r.pending;
            return renderCode(req, res, 401, "That code is not right. " + r.left + (r.left === 1 ? " try" : " tries") + " left.", null);
        }
        delete req.session.mfa;
        renderLogin(req, res, 401, p.login, r.result === "expired" ? "Your sign in code expired. Sign in again to get a new one." : "Too many wrong codes. Sign in again to get a new one.");
    }
    catch (err) { next(err); }
});

router.post("/login/mfa/resend", async (req, res, next) =>
{
    try
    {
        if (req.user) { return res.redirect("/account"); }
        const p = req.session.mfa;
        if (!p) { return res.redirect("/login"); }
        const user = await users.findById(p.userId);
        if (!user || user.delete_epoch !== null) { delete req.session.mfa; return res.redirect("/login"); }
        if (user.disabled_epoch) { delete req.session.mfa; return renderLogin(req, res, 403, p.login, OFFLINE_MESSAGE); }
        const r = await mfa.resend(p, user);
        if (r.status === "sent")
        {
            req.session.mfa = Object.assign(r.pending, { notice: "We sent a new code. Use the newest one." });
            await activity.log(req, "mfa_sent", Object.assign(mfaActor(user), { detail: sendDetail("resend", r.sent) }));
            return res.redirect(303, "/login/mfa");
        }
        if (r.status === "cooldown")
        {
            return renderCode(req, res, 429, null, "You can ask for a new code in " + r.seconds + (r.seconds === 1 ? " second." : " seconds."));
        }
        if (r.status === "failed")
        {
            await activity.log(req, "mfa_send_failed", Object.assign(mfaActor(user), { outcome: "failed", detail: sendDetail("resend", r.sent) }));
            return renderCode(req, res, 503, "We could not send a new code. The code you already have still works.", null);
        }
        delete req.session.mfa;
        renderLogin(req, res, r.status === "capped" ? 429 : 401, p.login, r.status === "capped" ? "Too many new codes. Sign in again to get a new one." : "Your sign in code expired. Sign in again to get a new one.");
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
        // An offline user gets no link; the page says the same as always.
        if (user && !user.disabled_epoch)
        {
            await require("../services/resetLink").send(user);
        }
        await activity.log(req, "password_reset_requested", Object.assign({ actor_name: login.slice(0, 80) }, user && user.disabled_epoch ? { outcome: "denied", detail: "user offline, not sent" } : {}));
        res.render("auth/forgot", Object.assign({ title: "Reset password", sent: true }, AUTH));
    }
    catch (err) { next(err); }
});

// Dead reset link: a friendly page that never says why, and the reason in the activity log.
async function resetLinkDead(req, res, row, why)
{
    const reason = why || (row ? "account deleted" : await tokens.deadReason("password_reset", req.params.token));
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
        if (user.disabled_epoch) { return resetLinkDead(req, res, row, "user offline"); }
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
        if (user.disabled_epoch) { return resetLinkDead(req, res, row, "user offline"); }
        await startSession(req, user, { mustSetPassword: true });
        req.user = user;
        await activity.log(req, "login_via_reset_link");
        req.flash("info", "Set a new password to continue.");
        res.redirect("/profile/password");
    }
    catch (err) { next(err); }
});

// A signed in visitor never gets the accept form (the page would carry that session's CSRF token);
// the invite is only read, so the link still works after signing out.
function inviteWhileSignedIn(req, res, inv)
{
    res.render("auth/invite-signed-in", Object.assign({ title: "You are already signed in", username: req.user.username, invite: Object.assign({ token: req.params.token }, inv) }, AUTH));
}

router.get("/invite/:token", async (req, res, next) =>
{
    try
    {
        const inv = await invites.findValid(req.params.token);
        if (!inv) { return res.status(410).render("auth/link-dead", Object.assign({ title: "Invitation expired" }, AUTH)); }
        if (req.user) { return inviteWhileSignedIn(req, res, inv); }
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
            if (req.user) { return inviteWhileSignedIn(req, res, inv); }
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

// Sign out and continue: ends the current session and reopens the invite, whose GET starts a fresh
// session and CSRF token. Its own route rather than a return field on /logout, so no open redirect.
router.post("/invite/:token/sign-out", (req, res) =>
{
    activity.log(req, "logout");
    req.session.destroy(() => res.redirect("/invite/" + encodeURIComponent(req.params.token)));
});

module.exports = router;
