// Outbound webhooks (architecture 10): the pipeline enqueues from stage 6; the minute job
// delivers with an HMAC signature and backs off on failure (1, 5, 30, 120 min, then failed).
const crypto = require("crypto");
const settings = require("../config/settings");
const logger = require("../config/logger");
const { knex, T, nowEpoch } = require("../db/knex");

const BACKOFF = [60, 300, 1800, 7200];
const hookCache = new Map();   // account_id -> { at, hooks }

async function hooksFor(accountId)
{
    const hit = hookCache.get(accountId);
    if (hit && Date.now() - hit.at < 60000) { return hit.hooks; }
    const hooks = await knex(T("webhooks")).where({ account_id: accountId, is_enabled: 1 }).whereNull("delete_epoch");
    hookCache.set(accountId, { at: Date.now(), hooks: hooks });
    return hooks;
}

async function enqueue(accountId, eventType, payload)
{
    const hooks = await hooksFor(accountId);
    for (const h of hooks)
    {
        if (!h.event_types.split(",").includes(eventType)) { continue; }
        await knex(T("webhook_deliveries")).insert({ webhook_id: h.id, epoch: nowEpoch(), event_type: eventType, payload: JSON.stringify(payload), attempts: 0, next_attempt_epoch: nowEpoch(), outcome: "pending" });
    }
}

async function deliverPending()
{
    const now = nowEpoch();
    const due = await knex(T("webhook_deliveries")).where({ outcome: "pending" }).where("next_attempt_epoch", "<=", now).orderBy("id").limit(200);
    for (const d of due)
    {
        const hook = await knex(T("webhooks")).where({ id: d.webhook_id }).first();
        if (!hook || !hook.is_enabled || hook.delete_epoch) { await knex(T("webhook_deliveries")).where({ id: d.id }).update({ outcome: "failed", next_attempt_epoch: null }); continue; }
        const secret = settings.decrypt(hook.signing_secret_enc);
        const body = d.payload;
        const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
        let status = null;
        try
        {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 10000);
            const res = await fetch(hook.url, { method: "POST", headers: { "content-type": "application/json", "x-iot-signature": sig, "x-iot-event": d.event_type, "x-iot-delivery": String(d.id) }, body: body, signal: ctl.signal });
            clearTimeout(timer);
            status = res.status;
        }
        catch (err) { status = 0; logger.warn({ hook: hook.name, err: err.message }, "webhook delivery error"); }
        const attempts = d.attempts + 1;
        if (status >= 200 && status < 300) { await knex(T("webhook_deliveries")).where({ id: d.id }).update({ attempts: attempts, status_code: status, outcome: "sent", next_attempt_epoch: null }); }
        else if (attempts > BACKOFF.length) { await knex(T("webhook_deliveries")).where({ id: d.id }).update({ attempts: attempts, status_code: status || null, outcome: "failed", next_attempt_epoch: null }); }
        else { await knex(T("webhook_deliveries")).where({ id: d.id }).update({ attempts: attempts, status_code: status || null, next_attempt_epoch: now + BACKOFF[attempts - 1] }); }
    }
}

module.exports = { enqueue, deliverPending };
