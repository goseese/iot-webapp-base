// event_log (migration 0002, DECISIONS.md "Event log"): request start and end rows plus handler,
// job and device events, grouped by correlation_id. time is epoch milliseconds.
const { knex, T } = require("../knex");

// Every row also goes to the live viewer first (realtime.emitLog, a no-op where there is no socket
// server), so the live view still shows it if the insert fails.
function insert(row)
{
    const r =
    {
        time: row.time || Date.now(),
        user_id: row.user_id || null,
        api_credential_id: row.api_credential_id || null,
        account_id: row.account_id || null,
        channel: row.channel || null,
        event: String(row.event).slice(0, 50),
        correlation_id: row.correlation_id || null,
        details: row.details || null
    };
    try { require("../../realtime").emitLog(r); }
    catch (err) { /* the live view is best effort */ }
    return knex(T("event_log")).insert(Object.assign({}, r, { details: r.details ? JSON.stringify(r.details) : null }));
}

// Login lockout counting (services/activity.loginLocked): rows of one event since sinceEpoch
// (seconds) whose details field equals value. Only the fields the lockout uses are allowed.
const COUNT_FIELDS = ["actor_name", "ip"];

async function countRecent(event, field, value, sinceEpoch)
{
    if (!COUNT_FIELDS.includes(field)) { throw new Error("countRecent: unsupported field " + field); }
    if (value === null || value === undefined || value === "") { return 0; }
    const r = await knex(T("event_log"))
        .where({ event: event })
        .where("time", ">=", sinceEpoch * 1000)
        .whereRaw("details->>? = ?", [field, String(value)])
        .count("id as n")
        .first();
    return Number(r.n);
}

// Newest time (epoch seconds) of one event on one entity with one detail since sinceEpoch, or
// null. Used for device command cooldowns; the time bound keeps it on ix_event_log_event_time.
async function lastEpoch(event, entityUid, detail, sinceEpoch)
{
    const r = await knex(T("event_log"))
        .where({ event: event })
        .where("time", ">=", sinceEpoch * 1000)
        .whereRaw("details->>'entity_uid' = ?", [String(entityUid)])
        .whereRaw("details->>'detail' = ?", [String(detail)])
        .max("time as t")
        .first();
    return r && r.t ? Math.floor(Number(r.t) / 1000) : null;
}

// The Admin > Event log page. f: { cid, since, beforeTime, beforeId, userId, apiCredentialId,
// accountId, event, channel, errors }, all optional except since. A correlation id shows every row
// of that request, oldest first, whatever the other filters say. Otherwise newest first, paged by
// the (time, id) of the last row shown, so rows sharing a millisecond are never skipped.
function list(f, limit)
{
    const q = knex(T("event_log")).limit(limit);
    if (f.cid)
    {
        return q.where("correlation_id", f.cid).orderBy([{ column: "time", order: "asc" }, { column: "id", order: "asc" }]);
    }
    q.where("time", ">=", f.since).orderBy([{ column: "time", order: "desc" }, { column: "id", order: "desc" }]);
    if (f.beforeTime && f.beforeId) { q.whereRaw("(time, id) < (?, ?)", [f.beforeTime, f.beforeId]); }
    if (f.userId) { q.where("user_id", f.userId); }
    if (f.apiCredentialId) { q.where("api_credential_id", f.apiCredentialId); }
    if (f.accountId) { q.where("account_id", f.accountId); }
    if (f.event) { q.where("event", f.event); }
    if (f.channel) { q.where("channel", f.channel); }
    if (f.errors) { q.where("event", "request_end").whereRaw("(details->>'status')::int >= 400"); }
    return q;
}

// Event names seen since sinceMs, for the filter's suggestions.
async function eventNames(sinceMs)
{
    const rows = await knex(T("event_log")).where("time", ">=", sinceMs).distinct("event").orderBy("event");
    return rows.map((r) => r.event);
}

module.exports = { insert, countRecent, lastEpoch, list, eventNames };
