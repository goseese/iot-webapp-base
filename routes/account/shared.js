// Shared by the account pages: the user's effective bits at the current account, and the
// ceiling for granting at a scope (account or one of its locations).
const { knex, T } = require("../../db/knex");
const grants = require("../../services/grants");

async function bits(req) { return req.account ? grants.effectiveAtAccount(req, req.account.id) : 0n; }

async function ceilingAt(req, scopeType, scopeId)
{
    if (scopeType === "account") { return grants.effectiveAtAccount(req, req.account.id); }
    const loc = await knex(T("locations")).where({ id: scopeId, account_id: req.account.id }).whereNull("delete_epoch").first();
    return loc ? grants.effectiveAtLocation(req, loc) : 0n;
}

module.exports = { bits, ceilingAt };
