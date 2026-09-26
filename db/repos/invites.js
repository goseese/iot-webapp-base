const { knex, T, insertId } = require("../knex");

function findLiveByEmail(email)
{
    return knex(T("invites")).where({ email: email }).whereNull("accepted_epoch").whereNull("cancelled_epoch").first();
}
function findByHash(hash) { return knex(T("invites")).where({ token_hash: hash }).first(); }
function findByUid(uid) { return knex(T("invites")).where({ uid: uid }).first(); }

async function insert(row)
{
    const r = await knex(T("invites")).insert(row).returning("id");
    return insertId(r);
}

function update(id, patch, trx) { return (trx || knex)(T("invites")).where({ id: id }).update(patch); }

function listForScope(scopeType, scopeId)
{
    return knex(T("invites")).where({ scope_type: scopeType, scope_id: scopeId }).whereNull("accepted_epoch").whereNull("cancelled_epoch");
}

module.exports = { findLiveByEmail, findByHash, findByUid, insert, update, listForScope };
