// The only writer of audit_log; called inside the same transaction as the change.
const { T, nowEpoch } = require("../db/knex");

function audit(trx, entry)
{
    return trx(T("audit_log")).insert(
    {
        epoch: nowEpoch(),
        entity_type: entry.entityType,
        entity_uid: entry.entityUid,
        entity_name: entry.entityName || null,
        field: entry.field,
        old_value: entry.oldValue === undefined || entry.oldValue === null ? null : String(entry.oldValue),
        new_value: entry.newValue === undefined || entry.newValue === null ? null : String(entry.newValue),
        actor_type: entry.actorType || "system",
        actor_id: entry.actorId || null,
        actor_name: entry.actorName || null
    });
}

module.exports = { audit };
