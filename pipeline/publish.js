// Stage 6: the only emitter (conventions.md section 9). Publishes to acct/{account_uid}/...
// for account subscribers and the web process, and to webhooks (later step).
const { knex, T } = require("../db/knex");
const mqttClient = require("../mqtt/client");
const logger = require("../config/logger");

const accountUidCache = new Map();   // location_id -> account uid
const accountIdCache = new Map();    // location_id -> account id

async function accountUidForLocation(locationId)
{
    if (accountUidCache.has(locationId)) { return accountUidCache.get(locationId); }
    const row = await knex(T("locations") + " as l").join(T("accounts") + " as a", "a.id", "l.account_id").where("l.id", locationId).select("a.uid", "a.id").first();
    const uid = row ? String(row.uid).toLowerCase() : null;
    accountUidCache.set(locationId, uid);
    accountIdCache.set(locationId, row ? row.id : null);
    return uid;
}

async function batch(device, accepted, transitions, epoch)
{
    if (accepted.length === 0 && transitions.length === 0) { return; }
    const accountUid = await accountUidForLocation(device.location_id);
    if (!accountUid) { return; }
    const accountId = accountIdCache.get(device.location_id);
    const webhooks = require("../services/webhooks");
    const devUid = String(device.uid).toLowerCase();
    if (accepted.length > 0) { await webhooks.enqueue(accountId, "reading", { event: "reading", device: devUid, epoch: epoch, readings: accepted.map((a) => ({ sensor: String(a.sensorUid).toLowerCase(), channel: a.channel, metric: a.metric, value: a.value, epoch: a.epoch })) }).catch((err) => logger.warn({ err: err.message }, "webhook enqueue failed")); }
    for (const t of transitions) { await webhooks.enqueue(accountId, "alarm", Object.assign({ event: "alarm", device: devUid, epoch: epoch }, t)).catch((err) => logger.warn({ err: err.message }, "webhook enqueue failed")); }

    const client = mqttClient.get();
    if (!client || !client.connected) { return; }

    const payload =
    {
        device: String(device.uid).toLowerCase(),
        epoch: epoch,
        readings: accepted.map((a) => ({ sensor: String(a.sensorUid).toLowerCase(), channel: a.channel, metric: a.metric, value: a.value, epoch: a.epoch })),
        alarms: transitions
    };
    client.publish(require("../mqtt/topics").account.data(accountUid), JSON.stringify(payload), { qos: 0 }, (err) =>
    {
        if (err) { logger.warn({ err: err.message }, "acct publish failed"); }
    });
}

module.exports = { batch, accountUidForLocation };
