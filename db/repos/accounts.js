const { knex, T, insertId } = require("../knex");

function findById(id) { return knex(T("accounts")).where({ id: id }).first(); }
function findByUid(uid) { return knex(T("accounts")).where({ uid: uid }).whereNull("delete_epoch").first(); }
function findByName(name) { return knex(T("accounts")).where({ name: name }).whereNull("delete_epoch").first(); }

function insert(row, trx)
{
    return (trx || knex)(T("accounts")).insert(row).returning("id").then((r) => insertId(r));
}

module.exports = { findById, findByUid, findByName, insert };
