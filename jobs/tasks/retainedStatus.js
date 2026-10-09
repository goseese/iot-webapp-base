// Clears the retained status of units silent for RETAINED_STATUS_DAYS (DECISIONS.md "Retained
// status cleanup", step 3). A gateway that was lost, run over or taken out of service keeps its last
// retained status (connect message or offline will) on the broker for good, and the ingest client
// receives every one of them on each reconnect. An empty retained publish removes it
// (mqtt/downlink.clearRetained). Nothing is lost: a unit that comes back republishes its retained
// connect message, and ingest sets status_cleared_epoch back to NULL when it hears it.
//
// Rule: ever connected (mqtt_seen_epoch set), not cleared yet, and last heard (mqtt_last_epoch, or
// mqtt_seen_epoch for a unit not heard since migration 0017) before the cutoff. Revoked units are
// included: Reprovision clears at once, and this catches one whose clear could not be sent.
const { knex, T, nowEpoch } = require("../../db/knex");
const logger = require("../../config/logger");
const settings = require("../../config/settings");
const topics = require("../../mqtt/topics");
const downlink = require("../../mqtt/downlink");

const BATCH = 500;              // a backlog finishes over the following days

async function run()
{
    const days = Number(settings.get("RETAINED_STATUS_DAYS", 30));
    if (!(days > 0)) { return; }   // 0 turns the cleanup off
    const now = nowEpoch();
    const cutoff = now - days * 86400;
    const rows = await knex(T("device_credentials"))
        .whereNull("delete_epoch")
        .whereNotNull("broker_username")
        .whereNotNull("mqtt_seen_epoch")
        .whereNull("status_cleared_epoch")
        .whereRaw("COALESCE(mqtt_last_epoch, mqtt_seen_epoch) < ?", [cutoff])
        .orderBy("id")
        .limit(BATCH)
        .select("id", "mac", "broker_username");
    if (rows.length === 0) { return; }

    let cleared = 0;
    for (const r of rows)
    {
        const guid = String(r.broker_username).toLowerCase();
        if (!(await downlink.clearRetained(topics.device.status(guid))))
        {
            // No broker connection: the rest wait for the next run.
            logger.warn({ cleared: cleared, waiting: rows.length - cleared }, "retained status cleanup stopped; no broker connection");
            return;
        }
        await knex(T("device_credentials")).where({ id: r.id }).whereNull("status_cleared_epoch").update({ status_cleared_epoch: now });
        cleared++;
    }
    logger.info({ cleared: cleared, days: days }, "retained status cleanup complete");
}

module.exports = { run };
