// Middleware chain: session -> loadUser -> mustSetPassword confinement -> requireBits -> route.
const settings = require("../config/settings");
const { notFoundError } = require("./errors");
const users = require("../db/repos/users");
const permissions = require("../permissions");

async function loadUser(req, res, next)
{
    res.locals.currentUser = null;
    res.locals.siteName = settings.get("SITE_NAME", "DevMon");
    try
    {
        if (req.session && req.session.userId)
        {
            const user = await users.findById(req.session.userId);
            // A password change invalidates every session started before it (architecture 4.2).
            const stale = user && user.password_changed_epoch && req.session.loginEpoch && req.session.loginEpoch < user.password_changed_epoch;
            if (!user || user.delete_epoch !== null || stale)
            {
                return req.session.destroy(() => res.redirect("/login"));
            }
            req.user = user;
            res.locals.currentUser = user;
        }
        next();
    }
    catch (err)
    {
        next(err);
    }
}

function requireLogin(req, res, next)
{
    if (!req.user)
    {
        if (req.method === "GET") { req.session.returnTo = req.originalUrl; }
        return res.redirect("/login");
    }
    next();
}

function requireSuperadmin(req, res, next)
{
    if (!req.user) { return requireLogin(req, res, next); }
    if (!req.user.is_superadmin)
    {
        return next(notFoundError());
    }
    next();
}

// Confinement: a magic link login or a seeded account may only reach the set password page
// and logout until a password is set (architecture 4.2).
const CONFINED_OK = ["/profile/password", "/logout"];

function mustSetPassword(req, res, next)
{
    const confined = req.user && (req.session.mustSetPassword || req.user.must_set_password);
    if (confined && !CONFINED_OK.some((p) => req.path.startsWith(p)))
    {
        return res.redirect("/profile/password");
    }
    next();
}

// requireBits("location", ["edit"]) resolves req.params.uid to a location, checks the union
// permission, attaches req.scope, and 404s on denial (no existence leak). Same for "account".
function requireBits(scopeType, bitNames)
{
    const required = permissions.bitsOf(bitNames);
    return async function (req, res, next)
    {
        try
        {
            if (!req.user) { return requireLogin(req, res, next); }
            const grants = require("../services/grants");
            let effective = 0n;
            let scope = null;
            if (scopeType === "location")
            {
                scope = await require("../db/repos/locations").findByUid(req.params.uid);
                if (scope) { effective = await grants.effectiveAtLocation(req, scope); }
            }
            else
            {
                scope = await require("../db/repos/accounts").findByUid(req.params.uid);
                if (scope) { effective = await grants.effectiveAtAccount(req, scope.id); }
            }
            if (!scope || !permissions.has(effective, required))
            {
                return next(notFoundError());
            }
            req.scope = scope;
            req.scopeBits = effective;
            next();
        }
        catch (err)
        {
            next(err);
        }
    };
}

module.exports = { loadUser, requireLogin, requireSuperadmin, mustSetPassword, requireBits };
