// Current account and current location for the page. Both come from the URL (/account/<uid>/...)
// or from the entity the page loads (location, device, sensor, alarm, chart, report), never from
// the session, so any page can be rebuilt from its link (DECISIONS "Every page rebuilds from its URL").
const { knex, T } = require("../db/knex");
const grants = require("../services/grants");
const { notFoundError } = require("./errors");

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres refuses to compare a UUID or integer column with text that is not one (22P02), which
// ended the request as a 500 (DECISIONS.md "Malformed ids are not found"). Ids from URLs, queries
// and bodies are checked first, so a malformed id is the same plain 404 as a missing row.
function isUuid(v)
{
    return typeof v === "string" && GUID_RE.test(v);
}

// router.param handlers: router.param("uid", uidParam), router.param("grantId", intParam).
function uidParam(req, res, next, value)
{
    return isUuid(value) ? next() : next(notFoundError());
}

function intParam(req, res, next, value)
{
    return /^\d{1,9}$/.test(String(value)) ? next() : next(notFoundError());
}

function base(account) { return "/account/" + String(account.uid).toLowerCase(); }

// Loads the accounts the user can view. The page's own account is set later, by loadAccount for
// /account/<uid>/... or by useAccount / enterLocation for pages that load an entity.
async function currentAccount(req, res, next)
{
    try
    {
        req.account = null;
        req.visibleAccounts = [];
        res.locals.accounts = [];
        Object.defineProperty(req, "acctBase", { enumerable: true, configurable: true, get: () => req.account ? base(req.account) : "/account" });
        Object.defineProperty(res.locals, "account", { enumerable: true, configurable: true, get: () => req.account || null });
        Object.defineProperty(res.locals, "acctBase", { enumerable: true, configurable: true, get: () => req.acctBase });
        if (!req.user) { return next(); }
        const ids = await grants.visibleAccountIds(req);
        if (ids.length === 0) { return next(); }
        req.visibleAccounts = await knex(T("accounts")).whereIn("id", ids).whereNull("delete_epoch").orderBy("name");
        res.locals.accounts = req.visibleAccounts;
        next();
    }
    catch (err) { next(err); }
}

// Mounted on /account/:accountUid. An account the user cannot view looks missing.
function loadAccount(req, res, next)
{
    const uid = String(req.params.accountUid || "");
    if (!GUID_RE.test(uid))
    {
        // Pre-URL paths (/account/locations and the like) cannot know the account: go to the list.
        if (req.method === "GET") { return res.redirect("/account"); }
        return next(notFoundError());
    }
    const account = req.visibleAccounts.find((a) => String(a.uid).toLowerCase() === uid.toLowerCase());
    if (!account) { return next(notFoundError()); }
    req.account = account;
    next();
}

// For pages that load an entity by its own uid: the entity's account becomes the page's account.
// False when the user cannot view that account, or when the URL already named a different one.
function useAccount(req, accountId)
{
    if (req.account) { return req.account.id === accountId; }
    const account = req.visibleAccounts.find((a) => a.id === accountId);
    if (!account) { return false; }
    req.account = account;
    return true;
}

// Called by pages inside a location: puts the Monitor section in the sidebar for this request
// and makes the location's account the page's account.
function enterLocation(req, location)
{
    if (!location) { return; }
    const account = req.visibleAccounts.find((a) => a.id === location.account_id);
    if (account) { req.account = account; }
    req.currentLocation = location;
    req.navLocation = location;
}

// Monitor pages need a location; without one, send the user to the account list.
function requireLocation(req, res, next)
{
    if (!req.currentLocation)
    {
        req.flash("info", "Pick a location first.");
        return res.redirect("/account");
    }
    next();
}

module.exports = { currentAccount, loadAccount, useAccount, enterLocation, requireLocation, base, GUID_RE, isUuid, uidParam, intParam };
