// Pod stations (DECISIONS.md "Pod stations"): the type modules and the JSON frame header.
const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";
const types = require("../deviceTypes");

test("pod models map to their types; only controllers and account pods provision", () =>
{
    assert.equal(types.forModel("vpod-ctl").slug, "controller_pod");
    assert.equal(types.forModel("vpod-acct").slug, "account_pod");
    assert.equal(types.forModel("vpod-acc").slug, "target_accel");
    assert.equal(types.forModel("vpod-tof").slug, "target_tof");
    assert.equal(types.get("controller_pod").kind, "gateway");
    assert.equal(types.get("account_pod").kind, "gateway");
    assert.equal(types.get("target_accel").kind, "node");
    assert.equal(types.get("target_tof").kind, "node");
    assert.equal(types.all["pod"], undefined, "the shared module is not a device type");
});

test("target pods pair only with station types", () =>
{
    for (const slug of ["target_accel", "target_tof"])
    {
        const t = types.get(slug);
        assert.ok(t.pairsWith.length > 0);
        t.pairsWith.forEach((s) => assert.equal(types.get(s).station, true, slug + " pairs with " + s));
        assert.equal(t.dedupMode, "counter");
    }
    assert.ok(!types.get("account_pod").station);
    assert.equal(types.get("controller_pod").configKeys.pair_mode.kind, "bool");
});

test("a target pod's signal is kept per controller", () =>
{
    const v = types.gatewayValues(types.get("target_accel"), "02AA0000BEEF", { rssi: -58 });
    assert.equal(v["rssi-be:ef"], -58);
});

test("JSON frame header: MAC normalized, counter survives a reboot", () =>
{
    const { jsonFrameHeader } = require("../pipeline/identify");
    const h = jsonFrameHeader({ mac: "a4:cf:12:34:56:78", model: "vpod-acc", fw: "1.0.3", boot: 3, seq: 7, data: {} });
    assert.equal(h.mac, "A4CF12345678");
    assert.equal(h.counter, 3 * 4294967296 + 7);
    assert.notEqual(jsonFrameHeader({ mac: "A4CF12345678", boot: 4, seq: 7, data: {} }).counter, h.counter);
    assert.equal(jsonFrameHeader({ mac: "A4CF12345678", seq: 7, data: {} }).counter, 7, "no boot: seq alone");
    assert.equal(jsonFrameHeader({ mac: "A4CF12345678", data: {} }).counter, null, "no seq: no dedup");
    assert.equal(jsonFrameHeader({ mac: "A4CF1234", data: {} }), null, "short MAC refused");
});

test("pairing values read as the config page writes them", () =>
{
    const { truthy } = require("../services/stations");
    ["true", "1", "on", "yes", "TRUE"].forEach((v) => assert.equal(truthy(v), true, v));
    ["false", "0", "", null, undefined, "off"].forEach((v) => assert.equal(truthy(v), false, String(v)));
});
