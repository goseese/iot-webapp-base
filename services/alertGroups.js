// Default alert group per account: one level, no wait, everyone with location access. The
// flat distribution case of the ladder model (architecture 8.5).
const { knex, T, nowEpoch, insertId } = require("../db/knex");

async function ensureDefault(accountId, trx)
{
    const db = trx || knex;
    const existing = await db(T("alert_groups")).where({ account_id: accountId, is_default: 1 }).whereNull("delete_epoch").first();
    if (existing) { return existing.id; }
    const r = await db(T("alert_groups")).insert({ account_id: accountId, name: "Default", is_default: 1, created_epoch: nowEpoch() }).returning("id");
    const groupId = insertId(r);
    const l = await db(T("alert_group_levels")).insert({ alert_group_id: groupId, level_no: 1, wait_minutes: 0 }).returning("id");
    const levelId = insertId(l);
    await db(T("alert_group_recipients")).insert({ level_id: levelId, recipient_type: "all_access", recipient_id: null });
    return groupId;
}

module.exports = { ensureDefault };
