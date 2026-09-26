const { knex, T, insertId } = require("../knex");

function findById(id) { return knex(T("locations")).where({ id: id }).first(); }
function findByUid(uid) { return knex(T("locations")).where({ uid: uid }).whereNull("delete_epoch").first(); }

function findByAccountAndName(accountId, name)
{
    return knex(T("locations")).where({ account_id: accountId, name: name }).whereNull("delete_epoch").first();
}

function insert(row, trx)
{
    return (trx || knex)(T("locations")).insert(row).returning("id").then((r) => insertId(r));
}

module.exports = { findById, findByUid, findByAccountAndName, insert };
