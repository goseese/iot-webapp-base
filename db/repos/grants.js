const { knex, T } = require("../knex");

function listForUser(userId)
{
    return knex(T("grants")).where({ grantee_type: "user", grantee_id: userId });
}

async function upsert(row, trx)
{
    const db = trx || knex;
    const key = { grantee_type: row.grantee_type, grantee_id: row.grantee_id, scope_type: row.scope_type, scope_id: row.scope_id };
    const existing = await db(T("grants")).where(key).first();
    if (existing) { return db(T("grants")).where({ id: existing.id }).update({ permission_bits: row.permission_bits }); }
    return db(T("grants")).insert(row);
}

module.exports = { listForUser, upsert };
