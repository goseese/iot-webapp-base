// Revokes units that were issued credentials and never connected (migration 0020).
//
// Provisioning is unauthenticated and issues a unit to any MAC on first contact, so a unit that
// never followed through, whether a bench unit that was reflashed or someone posting made up MACs,
// would otherwise leave a device_credentials row and a dynsec client and role behind for good. The
// broker rewrites its whole dynamic-security.json on every change, so those are not free.
//
// Rule: issued (state active) more than CLEANUP_DAYS ago, and no MQTT message ever received
// (mqtt_seen_epoch NULL, stamped by pipeline/identify.js on a unit's first message). Placement does
// not matter: if such a unit comes back later it is simply a first contact again, and its data
// still reaches its placement because routing goes by MAC.
//
// Revoking deletes the broker account and soft deletes the credential row, which frees the MAC. The
// device_registry row is never touched: it is the permanent birth record (architecture 3.8).
const { knex, T, nowEpoch } = require("../../db/knex");
const logger = require("../../config/logger");
const broker = require("../../services/broker");
const activity = require("../../db/repos/activity");

const CLEANUP_DAYS = 30;
const BATCH = 200;              // a runaway backlog finishes over the following days

async function run()
{
    const now = nowEpoch();
    const rows = await knex(T("device_credentials"))
        .where("state", "active")
        .whereNull("delete_epoch")
        .whereNull("mqtt_seen_epoch")
        .where("activated_epoch", "<", now - CLEANUP_DAYS * 86400)
        .orderBy("id")
        .limit(BATCH)
        .select("id", "mac", "broker_username", "broker_password_enc");
    if (rows.length === 0) { return; }

    // With a driver that manages accounts, the broker has to be reachable: soft deleting a row whose
    // account still exists would orphan that account on the broker with nothing left pointing at it.
    const driver = broker.active();
    if (driver.managesUsers && typeof driver.connect === "function")
    {
        try { await driver.connect(); }
        catch (err)
        {
            logger.warn({ waiting: rows.length, err: err.message }, "unit cleanup skipped; dynsec not reachable");
            return;
        }
    }

    let revoked = 0;
    for (const r of rows)
    {
        const guid = String(r.broker_username).toLowerCase();
        try
        {
            if (r.broker_password_enc) { await driver.removeDeviceUser(guid); }
            await knex(T("device_credentials")).where({ id: r.id }).whereNull("delete_epoch").update({ delete_epoch: now });
            await activity.insert({ actor_type: "anonymous", actor_name: "system", action: "unit_cleanup", entity_type: "unit", entity_uid: guid, outcome: "ok", detail: r.mac + " issued and never connected in " + CLEANUP_DAYS + " days" });
            revoked++;
        }
        catch (err)
        {
            // Left in place so the next run tries again; nothing is soft deleted before the broker
            // account is gone.
            logger.error({ unit: guid, mac: r.mac, err: err.message }, "unit cleanup failed for this unit");
        }
    }
    logger.info({ revoked: revoked, candidates: rows.length, days: CLEANUP_DAYS }, "unit cleanup complete");
}

module.exports = { run };
