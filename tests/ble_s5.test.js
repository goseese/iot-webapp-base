const test = require("node:test");
const assert = require("node:assert");
const type = require("../deviceTypes/ble_s5");

const hex = (h) => Buffer.from(h, "hex");
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, a + " != " + b);

test("ble_s5 v04 sample from the legacy server", () =>
{
    const v = type.parseAdvertisement(hex("AAFE21040F0BE217FC3C03FD68FE4C024C010ECF"));
    assert.equal(v["int-vbat"], 3042);
    near(v["int-temp"], 23.98);
    near(v["int-humidity"], 60.01);
    assert.deepEqual([v["acc-x"], v["acc-y"], v["acc-z"]], [-664, -436, 588]);
    assert.equal(v["cycles"], 3791);
});

test("ble_s5 v00 sample from the legacy server", () =>
{
    const v = type.parseAdvertisement(hex("AAFE21000B0E3F14000010000C03F8"));
    assert.equal(v["int-vbat"], 3647);
    near(v["int-temp"], 20.0);
    assert.deepEqual([v["acc-x"], v["acc-y"], v["acc-z"]], [16, 12, 1016]);
    assert.equal(v["int-humidity"], undefined);
});

test("ble_s5 negative temperature matches the legacy fixed8_8_to_decimal", () =>
{
    // 0xFF80 -> -0.5, 0xEC40 -> -19.75 (legacy: (c >> 8) + (c & 0xFF) / 256)
    near(type.parseAdvertisement(hex("AAFE21000B0E3FFF800010000C03F8"))["int-temp"], -0.5);
    near(type.parseAdvertisement(hex("AAFE21000B0E3FEC400010000C03F8"))["int-temp"], -19.75);
});

test("per gateway channels use the last two bytes of the gateway MAC, XX:XX", () =>
{
    const types = require("../deviceTypes");
    assert.equal(types.gatewayChannelId(type, "rssi", "A846749F72B4"), "rssi-72:b4");
    assert.equal(types.gatewayChannelId(type, "int-temp", "A846749F72B4"), "int-temp");
    assert.deepEqual(types.gatewayValues(type, "A846749F72B4", { "rssi": -100, "heard-count": 16 }), { "rssi-72:b4": -100, "heard-count-72:b4": 16 });
    assert.deepEqual(types.gatewayValues(type, "A846749F72B4", { "rssi": -100, "heard-count": undefined }), { "rssi-72:b4": -100 });
    const def = types.channelDef(type, "heard-count-72:b4");
    assert.equal(def.name, "Heard Count 72:B4");
    assert.equal(def.metric, "count");
    assert.equal(def.base.id, "heard-count");
    assert.equal(types.channelDef(type, "signal-72:b4").metric, "percent");
    assert.equal(types.channelDef(type, "int-temp-72:b4"), null);
    assert.equal(types.channelDef(type, "rssi-72b4"), null);
    assert.equal(types.channelDef(type, "int-vbat").id, "int-vbat");
});

test("ble_s5 rejects other frames and short data", () =>
{
    assert.equal(type.parseAdvertisement(hex("AAFE20000BB8")), null);
    assert.equal(type.parseAdvertisement(hex("AAFE22000B0E3F14000010000C03F8")), null);
    assert.equal(type.parseAdvertisement(hex("AAFE21040F0BE217FC")), null);
    assert.equal(type.parseAdvertisement(Buffer.alloc(0)), null);
});
