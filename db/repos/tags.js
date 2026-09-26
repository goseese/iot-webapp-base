const { knex, T, insertId } = require("../knex");

async function getOrCreate(accountId, name, isKnown, trx)
{
    const db = trx || knex;
    const existing = await db(T("tags")).where({ account_id: accountId, name: name }).first();
    if (existing) { return existing.id; }
    const r = await db(T("tags")).insert({ account_id: accountId, name: name, is_known: isKnown ? 1 : 0 }).returning("id");
    return insertId(r);
}

async function tag(entityType, entityId, tagId, trx)
{
    const db = trx || knex;
    const existing = await db(T("taggings")).where({ tag_id: tagId, entity_type: entityType, entity_id: entityId }).first();
    if (!existing) { await db(T("taggings")).insert({ tag_id: tagId, entity_type: entityType, entity_id: entityId }); }
}

module.exports = { getOrCreate, tag };
