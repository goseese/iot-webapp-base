// Server published messages: device commands, and account notices (acct/{guid}/config). Uses
// whichever broker connection this process has: the ingest client
// on the leader, otherwise the realtime relay, which every web process runs. So a page action works
// on any farm server and the leader's connect time re-sends work too. Both connect as the platform
// broker user, whose role may publish anywhere (dynsec-broker-summary.md, legacy_full).
//
// Commands are never retained: clearing a retained message is itself a publish the device would
// receive. Anything that must survive the device being offline is kept in the database and re-sent
// when the device connects (see services/unitConfig.js).
const logger = require("../config/logger");

function connectedClient()
{
    const ingest = require("./client").get();
    if (ingest && ingest.connected) { return ingest; }
    const feed = require("../realtime").feedClient();
    if (feed && feed.connected) { return feed; }
    return null;
}

// Resolves true once the broker has the message (QoS 1 PUBACK), false when there is no connection
// or the publish fails. Never throws.
function publish(topic, payload)
{
    const c = connectedClient();
    if (!c)
    {
        logger.warn({ topic: topic }, "downlink not sent: no broker connection in this process");
        return Promise.resolve(false);
    }
    return new Promise((resolve) =>
    {
        c.publish(topic, String(payload), { qos: 1, retain: false }, (err) =>
        {
            if (err) { logger.warn({ topic: topic, err: err.message }, "downlink publish failed"); }
            resolve(!err);
        });
    });
}

module.exports = { publish };
