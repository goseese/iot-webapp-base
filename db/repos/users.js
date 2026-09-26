const { knex, T, insertId } = require("../knex");

function findById(id)
{
    return knex(T("users")).where({ id: id }).first();
}

function findByUid(uid)
{
    return knex(T("users")).where({ uid: uid }).whereNull("delete_epoch").first();
}

// Login accepts username or email; the caller routes on the presence of "@" (architecture 4.1).
function findByLogin(login)
{
    const col = login.includes("@") ? "email" : "username";
    return knex(T("users")).where(col, login).whereNull("delete_epoch").first();
}

function insert(row, trx)
{
    return (trx || knex)(T("users")).insert(row).returning("id").then((r) => insertId(r));
}

function update(id, patch, trx)
{
    return (trx || knex)(T("users")).where({ id: id }).update(patch);
}

module.exports = { findById, findByUid, findByLogin, insert, update };
