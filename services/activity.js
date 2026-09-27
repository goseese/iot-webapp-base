// Handler events for the event log (DECISIONS.md "Event log"). log(req, action, fields) keeps the
// shape the old activity log took, so its call sites did not change: the actor lands in the
// user_id or api_credential_id column, the rest (actor name, ip, user agent, outcome, entity,
// detail) in details, and the row carries the request's correlation id. Callers await security
// events (login_failed before loginLocked counts), so the write is done before the next check.
const crypto = require("crypto");
const events = require("../db/repos/events");
const settings = require("../config/settings");
const logger = require("../config/logger");
const { nowEpoch } = require("../db/knex");

const DETAIL_KEYS = ["actor_type", "actor_name", "ip", "user_agent", "outcome", "entity_type", "entity_uid", "detail"];

function actorOf(req)
{
    if (req.user) { return { actor_type: "user", actor_id: req.user.id, actor_name: req.user.username }; }
    if (req.apiCredential) { return { actor_type: "api_credential", actor_id: req.apiCredential.id, actor_name: req.apiCredential.name }; }
    return { actor_type: "anonymous", actor_id: null, actor_name: null };
}

// Same length as req.id, for jobs and anything else that runs outside a request.
function newCorrelationId()
{
    return crypto.randomBytes(6).toString("hex");
}

function toRow(action, f, ctx)
{
    const details = {};
    for (const k of DETAIL_KEYS)
    {
        if (f[k] !== undefined && f[k] !== null && f[k] !== "") { details[k] = f[k]; }
    }
    // An actor that is neither a user nor an API key (an alarm link contact) keeps its id here.
    if (f.actor_id && f.actor_type !== "user" && f.actor_type !== "api_credential") { details.actor_id = f.actor_id; }
    return {
        user_id: f.actor_type === "user" ? f.actor_id : null,
        api_credential_id: f.actor_type === "api_credential" ? f.actor_id : null,
        account_id: ctx.accountId || null,
        channel: ctx.channel || null,
        event: action,
        correlation_id: ctx.correlationId || null,
        details: details
    };
}

// Logging never breaks the work it records.
function write(row)
{
    return events.insert(row).catch((err) => { logger.warn({ err: err.message, event: row.event }, "event log write failed"); });
}

function log(req, action, fields)
{
    const f = Object.assign(actorOf(req),
    {
        ip: req.ip || null,
        user_agent: (req.get("user-agent") || "").slice(0, 300) || null,
        outcome: "ok"
    }, fields || {});
    return write(toRow(action, f,
    {
        channel: req.eventChannel || (req.apiCredential ? "api" : "web"),
        correlationId: req.id || null,
        accountId: req.account && req.account.id ? req.account.id : null
    }));
}

// An event outside a request (a job, ingest, a service handed no req).
// ctx: { channel: "job" | "mqtt" | "device", correlationId, accountId }.
function record(action, fields, ctx)
{
    const f = Object.assign({ actor_type: "system", actor_id: null, actor_name: "system", outcome: "ok" }, fields || {});
    return write(toRow(action, f, ctx || {}));
}

async function loginLocked(loginName, ip)
{
    const max = settings.get("LOGIN_MAX_FAILURES", 10);
    const since = nowEpoch() - settings.get("LOGIN_WINDOW_MINUTES", 15) * 60;
    const byName = await events.countRecent("login_failed", "actor_name", loginName, since);
    if (byName >= max) { return true; }
    const byIp = await events.countRecent("login_failed", "ip", ip, since);
    return byIp >= max;
}

module.exports = { log, record, loginLocked, actorOf, newCorrelationId };
