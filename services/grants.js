// Effective permission at a location = OR of the location grant and the account grant
// (architecture 4.3). Grants only add. Cached per request on req.grantCache.
const grantsRepo = require("../db/repos/grants");
const { knex, T } = require("../db/knex");
const permissions = require("../permissions");

async function loadUserGrants(req)
{
    if (!req.grantCache)
    {
        const rows = req.user ? await grantsRepo.listForUser(req.user.id) : [];
        req.grantCache = rows.map((r) => ({ scope_type: r.scope_type, scope_id: r.scope_id, bits: BigInt(r.permission_bits) }));
    }
    return req.grantCache;
}

async function effectiveAtLocation(req, location)
{
    if (req.user && req.user.is_superadmin) { return permissions.ALL; }
    const grants = await loadUserGrants(req);
    return grants.reduce((acc, g) =>
    {
        if (g.scope_type === "account" && g.scope_id === location.account_id) { return acc | g.bits; }
        if (g.scope_type === "location" && g.scope_id === location.id) { return acc | g.bits; }
        return acc;
    }, 0n);
}

async function effectiveAtAccount(req, accountId)
{
    if (req.user && req.user.is_superadmin) { return permissions.ALL; }
    const grants = await loadUserGrants(req);
    return grants.reduce((acc, g) => (g.scope_type === "account" && g.scope_id === accountId) ? acc | g.bits : acc, 0n);
}

// Accounts the user can see at all: any grant at the account or one of its locations.
async function visibleAccountIds(req)
{
    if (req.user && req.user.is_superadmin)
    {
        const rows = await knex(T("accounts")).whereNull("delete_epoch").select("id");
        return rows.map((r) => r.id);
    }
    const grants = await loadUserGrants(req);
    const ids = new Set(grants.filter((g) => g.scope_type === "account").map((g) => g.scope_id));
    const locIds = grants.filter((g) => g.scope_type === "location").map((g) => g.scope_id);
    if (locIds.length > 0)
    {
        const rows = await knex(T("locations")).whereIn("id", locIds).select("account_id");
        rows.forEach((r) => ids.add(r.account_id));
    }
    return Array.from(ids);
}

// Locations the user can see at all (view bit at the location or its account).
async function visibleLocations(req)
{
    const bit = permissions.byName.view;
    if (req.user && req.user.is_superadmin)
    {
        return knex(T("locations")).whereNull("delete_epoch").orderBy("name");
    }
    const grants = await loadUserGrants(req);
    const accountIds = grants.filter((g) => g.scope_type === "account" && (g.bits & bit) === bit).map((g) => g.scope_id);
    const locIds = grants.filter((g) => g.scope_type === "location" && (g.bits & bit) === bit).map((g) => g.scope_id);
    if (accountIds.length === 0 && locIds.length === 0) { return []; }
    return knex(T("locations")).whereNull("delete_epoch")
        .where(function () { if (accountIds.length) { this.whereIn("account_id", accountIds); } if (locIds.length) { this.orWhereIn("id", locIds); } })
        .orderBy("name");
}

async function can(req, location, bitName)
{
    const effective = await effectiveAtLocation(req, location);
    return permissions.has(effective, permissions.byName[bitName]);
}

// Ceiling rule: a grantor may only assign bits they hold at that scope.
function withinCeiling(grantorBits, requestedBits)
{
    return (BigInt(requestedBits) & ~BigInt(grantorBits)) === 0n;
}

module.exports = { loadUserGrants, effectiveAtLocation, effectiveAtAccount, visibleAccountIds, visibleLocations, can, withinCeiling };
