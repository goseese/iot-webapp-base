// MQTT topic scheme, the single place topics are built and parsed.
//
//   dev/{device_guid}/frame     uplink, one relayed LoRa frame + rssi
//   dev/{device_guid}/status    uplink, device self JSON, retained, LWT online:false
//   dev/{device_guid}/data      uplink, the device's own readings (not retained)
//   dev/{device_guid}/config/+  uplink, one config value per publish, key in the topic (not retained)
//   dev/{device_guid}/geoscan   uplink, wifi/cell scan for location (not retained)
//   dev/{device_guid}/cmd_ack   uplink, the device heard a command (not retained)
//   dev/{device_guid}/cmd       downlink commands. Everything the server sends a device lives at or
//                               under this, and ACLs are scoped to the subtree dev/{guid}/cmd/#, so
//                               dev/{guid}/cmd/reboot can be added later with no ACL change. A `#`
//                               subscription also matches the parent level (MQTT 3.1.1 4.7.1.2),
//                               which is why the server still publishes to the bare cmd topic.
//   acct/{account_guid}/#       server published account namespace
//   con/endpoint                retained, server published: the HTTPS provisioning URL. The only
//                               topic the shared `announce` credential is allowed to read.
const DEVICE_PREFIX = "dev";
const ACCOUNT_PREFIX = "acct";
const UPLINK_KINDS = ["frame", "status", "data", "geoscan", "cmd_ack"];
// Kinds whose last topic level is a key: dev/{guid}/config/{key}, one value per publish.
const KEYED_UPLINK_KINDS = ["config"];

const lower = (g) => String(g).toLowerCase();

const device =
{
    frame: (guid) => DEVICE_PREFIX + "/" + lower(guid) + "/frame",
    status: (guid) => DEVICE_PREFIX + "/" + lower(guid) + "/status",
    cmd: (guid) => DEVICE_PREFIX + "/" + lower(guid) + "/cmd",
    // One config write, bare value payload, not retained. The unit replies on config/{key}.
    setConfig: (guid, key) => DEVICE_PREFIX + "/" + lower(guid) + "/cmd/set_config/" + key,
    // One command (the Commands tab), not retained. Covered by the cmd/# ACL, so no role change.
    // name comes only from a type module's commands list, never from the request.
    command: (guid, name) => DEVICE_PREFIX + "/" + lower(guid) + "/cmd/" + name,
    cmdAll: (guid) => DEVICE_PREFIX + "/" + lower(guid) + "/cmd/#",
    all: (guid) => DEVICE_PREFIX + "/" + lower(guid) + "/#"
};

// acct/{guid}/config carries a notice only, { event: "config", device }, never values: the account
// namespace reaches every member of the account, and config holds WiFi passwords. Pages fetch the
// values through their own permission checked route.
const account =
{
    data: (guid) => ACCOUNT_PREFIX + "/" + lower(guid) + "/data",
    config: (guid) => ACCOUNT_PREFIX + "/" + lower(guid) + "/config",
    all: (guid) => ACCOUNT_PREFIX + "/" + lower(guid) + "/#"
};

// First contact. Firmware is configured with the broker host only, because the web app and the
// broker can be on different hosts. A device with no credentials connects as the shared `announce`
// user, whose role can read this one literal topic and nothing else, takes the provisioning URL
// from the retained message, disconnects and makes the HTTPS call. A literal topic, not a builder:
// it is the same string in every firmware image. Retained, QoS 1, published by the leader only.
const connect = { endpoint: "con/endpoint" };

// What the ingest process subscribes to.
const ingestSubscriptions = UPLINK_KINDS.map((k) => DEVICE_PREFIX + "/+/" + k)
    .concat(KEYED_UPLINK_KINDS.map((k) => DEVICE_PREFIX + "/+/" + k + "/+"));

// ACLs for a per device broker user, in the shape the dynsec control API takes: publish its own
// uplinks, subscribe to and receive its own commands, nothing else.
//
// The broker's default access for publishClientReceive is deny, so a role that can subscribe but
// carries no receive ACL lets a device subscribe successfully, be granted its QoS in the SUBACK,
// and then silently receive nothing: each delivery is refused and dropped with no error anywhere.
// The two are therefore emitted together by one loop below and must stay that way. Adding a
// downlink topic means adding it to DOWNLINK_TOPICS, never pushing a single ACL by hand.
const ACL_PRIORITY = 5;

const acl = (acltype, topic) => ({ acltype: acltype, topic: topic, priority: ACL_PRIORITY, allow: true });

// Every topic a device is allowed to be sent messages on.
const DOWNLINK_TOPICS = [(guid) => device.cmdAll(guid)];

function deviceAcls(guid)
{
    const acls = UPLINK_KINDS.map((k) => acl("publishClientSend", DEVICE_PREFIX + "/" + lower(guid) + "/" + k));
    for (const k of KEYED_UPLINK_KINDS)
    {
        acls.push(acl("publishClientSend", DEVICE_PREFIX + "/" + lower(guid) + "/" + k + "/+"));
    }
    for (const topicFor of DOWNLINK_TOPICS)
    {
        const topic = topicFor(guid);
        acls.push(acl("subscribePattern", topic));
        acls.push(acl("publishClientReceive", topic));
    }
    return acls;
}

// parse("dev/<guid>/frame") -> { kind: "device", guid, channel: "frame" }
// anything else -> null
function parse(topic)
{
    const parts = String(topic).split("/");
    if (parts[0] === DEVICE_PREFIX && parts.length === 3 && UPLINK_KINDS.includes(parts[2])) { return { kind: "device", guid: parts[1].toLowerCase(), channel: parts[2] }; }
    if (parts[0] === DEVICE_PREFIX && parts.length === 4 && KEYED_UPLINK_KINDS.includes(parts[2]) && parts[3] !== "") { return { kind: "device", guid: parts[1].toLowerCase(), channel: parts[2], key: parts[3] }; }
    return null;
}

module.exports = { DEVICE_PREFIX, ACCOUNT_PREFIX, device, account, connect, ingestSubscriptions, deviceAcls, parse };
