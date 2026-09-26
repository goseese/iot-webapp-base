const { knex, T, nowEpoch, insertId } = require("../knex");

async function insert(row)
{
    const r = await knex(T("notifications")).insert(Object.assign({ epoch: nowEpoch() }, row)).returning("id");
    return insertId(r);
}

function update(id, patch)
{
    return knex(T("notifications")).where({ id: id }).update(patch);
}

function countRecent(kind, recipientType, recipientId, sinceEpoch)
{
    return knex(T("notifications")).where({ kind: kind, recipient_type: recipientType, recipient_id: recipientId })
        .where("epoch", ">=", sinceEpoch).count("id as n").first().then((r) => Number(r.n));
}

module.exports = { insert, update, countRecent };
