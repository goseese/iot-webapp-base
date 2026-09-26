// Broker connection for the ingest role. Only the ingest process opens this; web never talks
// to the broker for ingest (conventions.md section 2). Messages go to pipeline/identify.
const mqtt = require("mqtt");
const broker = require("./broker");
const logger = require("../config/logger");

let client = null;
let started = false;         // true once the leader has asked for ingest; reconnect only then
let lastMessageEpoch = null;
let lastLatencyMs = 0;       // arrival to processed, for the ingest_lag_secs server stat
let queue = Promise.resolve();

function connect()
{
    started = true;
    if (client) { return client; }
    const cfg = broker.config();
    if (!cfg.configured)
    {
        logger.warn("mqtt not configured (MQTT_HOST is blank in site settings); ingest not connected");
        return null;
    }
    const c = mqtt.connect(cfg.url,
    {
        clientId: cfg.clientId,
        username: cfg.user || undefined,
        password: cfg.password || undefined,
        clean: false,                // durable session so provisioning requests survive a restart
        reconnectPeriod: 5000,
        connectTimeout: 15000,
        rejectUnauthorized: true
    });
    client = c;

    c.on("connect", (ack) =>
    {
        logger.info({ url: cfg.url, clientId: cfg.clientId, sessionPresent: ack.sessionPresent }, "mqtt connected");
        c.subscribe(require("./topics").ingestSubscriptions, { qos: 1 }, (err) =>
        {
            if (err) { logger.error({ err: err }, "mqtt subscribe failed"); }
        });
        // Refresh the retained first contact message on every connect, so a broker restart, a
        // failover or an MQTT settings change all leave a current URL and date in place.
        require("../services/connectEndpoint").publish();
    });
    c.on("reconnect", () => logger.warn("mqtt reconnecting"));
    c.on("error", (err) => logger.error({ err: err }, "mqtt error"));
    c.on("message", (topic, payload, packet) =>
    {
        const arrived = Date.now();
        lastMessageEpoch = Math.floor(arrived / 1000);
        // Serialized: the in memory dedup and hot column guards assume one frame at a time.
        // packet.retain is 1 only on a retained copy the broker sends because we subscribed, which
        // happens on every connect (MQTT 3.1.1 3.3.1.3, 3.8.4); a live publish arrives with 0.
        queue = queue.then(() => require("../pipeline/identify").handle(topic, payload, { retained: !!(packet && packet.retain) })).catch((err) =>
        {
            logger.error({ err: err.message, stack: err.stack, topic: topic }, "pipeline error");
        }).then(() => { lastLatencyMs = Date.now() - arrived; });
    });

    return c;
}

// Settings changed (mqtt/watch.js). Close the old connection first: the new one may use the
// same client id, and two live connections with one id kick each other off the broker.
function reconnect()
{
    if (!started) { return; }    // not the leader; ingest never started here
    const old = client;
    client = null;
    if (!old)
    {
        connect();
        return;
    }
    // force: a broker that is down or misconfigured must not hold up the switch; unacked
    // inbound QoS 1 messages are redelivered on the persistent session.
    old.end(true, {}, () => connect());
}

// Downlink to one device: dev/{guid}/cmd, QoS 1. Ingest process only.
function sendCommand(guid, payload)
{
    if (!client || !client.connected) { return false; }
    client.publish(require("./topics").device.cmd(guid), typeof payload === "string" ? payload : JSON.stringify(payload), { qos: 1 });
    return true;
}

function get() { return client; }
function isConnected() { return !!(client && client.connected); }
function lastMessage() { return lastMessageEpoch; }
function lastLatency() { return lastLatencyMs; }

module.exports = { connect, reconnect, get, sendCommand, isConnected, lastMessage, lastLatency };
