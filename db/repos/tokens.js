const { knex, T } = require("../knex");

function insert(row) { return knex(T("tokens")).insert(row); }
function findByHash(hash) { return knex(T("tokens")).where({ token_hash: hash }).first(); }
function markUsed(id, epoch) { return knex(T("tokens")).where({ id: id }).whereNull("used_epoch").update({ used_epoch: epoch }); }

// Issuing a new token for the same purpose and subject retires the older ones.
function retire(purpose, subjectType, subjectId, epoch)
{
    return knex(T("tokens")).where({ purpose: purpose, subject_type: subjectType, subject_id: subjectId }).whereNull("used_epoch").update({ used_epoch: epoch });
}

module.exports = { insert, findByHash, markUsed, retire };
