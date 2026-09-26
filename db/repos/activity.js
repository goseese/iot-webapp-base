const { knex, T, nowEpoch } = require("../knex");

function insert(row)
{
    return knex(T("activity_log")).insert(Object.assign({ epoch: nowEpoch() }, row));
}

// Login lockout counting comes from this table, no separate store (conventions.md section 6).
async function countRecent(action, field, value, sinceEpoch)
{
    const r = await knex(T("activity_log")).where({ action: action }).where(field, value).where("epoch", ">=", sinceEpoch).count("id as n").first();
    return Number(r.n);
}

// Newest epoch of one action on one entity with one detail since sinceEpoch, or null. Used for
// command cooldowns; the epoch bound keeps it on the epoch index.
async function lastEpoch(action, entityUid, detail, sinceEpoch)
{
    const r = await knex(T("activity_log")).where({ action: action, entity_uid: entityUid, detail: detail }).where("epoch", ">=", sinceEpoch).max("epoch as e").first();
    return r && r.e ? Number(r.e) : null;
}

function listRecent(limit)
{
    return knex(T("activity_log")).orderBy("epoch", "desc").limit(limit);
}

module.exports = { insert, countRecent, lastEpoch, listRecent };
