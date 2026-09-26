const test = require("node:test");
const assert = require("node:assert");
const topics = require("../mqtt/topics");

test("device topics use the dev/ prefix, lower case guid", () =>
{
    assert.equal(topics.device.frame("ABC-1"), "dev/abc-1/frame");
    assert.equal(topics.device.cmd("ABC-1"), "dev/abc-1/cmd");
    assert.equal(topics.device.setConfig("ABC-1", "rf_channel"), "dev/abc-1/cmd/set_config/rf_channel");
    assert.equal(topics.device.command("ABC-1", "publish_now"), "dev/abc-1/cmd/publish_now");
    assert.equal(topics.account.config("ACC-1"), "acct/acc-1/config");
    assert.deepEqual(topics.ingestSubscriptions, ["dev/+/frame", "dev/+/ble", "dev/+/status", "dev/+/data", "dev/+/geoscan", "dev/+/cmd_ack", "dev/+/config/+", "provision/request/+"]);
});

test("parse accepts platform topics and rejects legacy prefixes", () =>
{
    assert.deepEqual(topics.parse("dev/ABC/status"), { kind: "device", guid: "abc", channel: "status" });
    assert.deepEqual(topics.parse("provision/request/A4CF12345678"), { kind: "provision", hardwareId: "A4CF12345678" });
    assert.deepEqual(topics.parse("dev/ABC/data"), { kind: "device", guid: "abc", channel: "data" });
    assert.deepEqual(topics.parse("dev/ABC/config/rf_channel"), { kind: "device", guid: "abc", channel: "config", key: "rf_channel" });
    assert.equal(topics.parse("dev/abc/config"), null);       // config always carries its key
    assert.equal(topics.parse("dev/abc/config/"), null);
    assert.equal(topics.parse("dev/abc/config/a/b"), null);
    assert.equal(topics.parse("dev/abc/cmd"), null);          // downlink is never ingested
    assert.equal(topics.parse("dom/site1/frame"), null);
    assert.equal(topics.parse("dtm/x/y"), null);
    assert.ok(topics.isLegacy("dom/site1/frame"));
    assert.ok(!topics.isLegacy("dev/abc/frame"));
});

test("device ACLs: publish own uplinks, subscribe and receive own cmd subtree", () =>
{
    const acls = topics.deviceAcls("abc");
    assert.deepEqual(acls.map((a) => a.acltype + " " + a.topic),
    [
        "publishClientSend dev/abc/frame",
        "publishClientSend dev/abc/ble",
        "publishClientSend dev/abc/status",
        "publishClientSend dev/abc/data",
        "publishClientSend dev/abc/geoscan",
        "publishClientSend dev/abc/cmd_ack",
        "publishClientSend dev/abc/config/+",
        "subscribePattern dev/abc/cmd/#",
        "publishClientReceive dev/abc/cmd/#"
    ]);
    assert.ok(acls.every((a) => a.allow === true && a.priority === 5));
});

// The broker denies publishClientReceive by default, so a subscribe ACL without a receive ACL on the
// same topic lets a device subscribe, be granted its QoS, and then silently receive nothing. Guard
// the pairing itself, not just today's list, so adding a downlink topic the wrong way fails here.
test("device ACLs: every subscribe topic also has a receive ACL", () =>
{
    const acls = topics.deviceAcls("abc");
    const receive = new Set(acls.filter((a) => a.acltype === "publishClientReceive").map((a) => a.topic));
    const subscribes = acls.filter((a) => a.acltype.startsWith("subscribe"));
    assert.ok(subscribes.length > 0);
    for (const sub of subscribes) { assert.ok(receive.has(sub.topic), "no receive ACL for " + sub.topic); }
});
