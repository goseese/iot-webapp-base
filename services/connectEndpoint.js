// The retained con/endpoint message: how a device holding no credentials finds the provisioning URL
// (dynsec-broker-summary.md, "First contact").
//
// Topic comes from mqtt/topics.js, payload is:
//   { "url": "https://<app host>/provision/v1", "published": "2026-09-20T03:10:00Z" }
//
// The date is for a human with mosquitto_sub, so a glance says whether the message is current or
// left over from weeks ago. Firmware reads the url and ignores the rest, so a field can be added
// here without a firmware change.
//
// Published by the leader only. Three triggers, all of them ending up here:
//   1. Every ingest connect (mqtt/client.js), so a broker restart or a failover refreshes it.
//   2. An MQTT settings change, which mqtt/watch.js turns into a reconnect, so trigger 1 covers it.
//      That is why watch.js has no call of its own.
//   3. Once a day (jobs/tasks/connectEndpoint.js), so the date proves a leader is alive rather than
//      only proving one was restarted at some point.
const logger = require("../config/logger");
const topics = require("../mqtt/topics");
const broker = require("../mqtt/broker");

// Whole seconds. The milliseconds are noise in a field meant to be read by eye.
function stamp()
{
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function payload()
{
    return JSON.stringify({ url: broker.provisionUrl(), published: stamp() });
}

// Returns whether the publish was handed to the client, not whether the broker stored it.
function publish()
{
    if (!require("./leader").isLeader()) { return false; }
    const client = require("../mqtt/client").get();
    if (!client || !client.connected)
    {
        logger.warn("con/endpoint not published: no broker connection");
        return false;
    }
    const body = payload();
    client.publish(topics.connect.endpoint, body, { qos: 1, retain: true }, (err) =>
    {
        if (err)
        {
            logger.error({ topic: topics.connect.endpoint, err: err.message }, "con/endpoint publish failed");
            return;
        }
        logger.info({ topic: topics.connect.endpoint, payload: body }, "con/endpoint published");
    });
    return true;
}

module.exports = { publish, payload };
