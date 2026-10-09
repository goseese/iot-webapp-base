// Device messages: the JSON frame header, config values, queued commands and firmware files.
const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";

test("JSON frame header: MAC normalized, counter survives a reboot", () =>
{
    const { jsonFrameHeader } = require("../pipeline/identify");
    const h = jsonFrameHeader({ mac: "a4:cf:12:34:56:78", model: "example-model", fw: "1.0.3", boot: 3, seq: 7, data: {} });
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

test("ota: the value goes out as an object; firmware paths stay in their folder", () =>
{
    assert.equal(require("../services/firmware").filePath("../etc"), null);
    const { message } = require("../services/commandQueue");
    const m = JSON.parse(message({ cmd_id: "c1", cmd: "ota", target: "all", value: JSON.stringify({ url: "https://x/firmware/example-image/firmware.bin", md5: "0123456789abcdef0123456789abcdef" }) }));
    assert.deepEqual(m, { id: "c1", cmd: "ota", to: "all", value: { url: "https://x/firmware/example-image/firmware.bin", md5: "0123456789abcdef0123456789abcdef" } });
    assert.equal(JSON.parse(message({ cmd_id: "c2", cmd: "led", target: null, value: "FF0000" })).value, "FF0000");
});

test("firmware upload check: ESP32-S3 app images only; the typed version is looked for as a C string", () =>
{
    const fw = require("../services/firmware");
    const b = Buffer.alloc(400);
    b[0] = 0xE9; b.writeUInt16LE(9, 12); b.writeUInt32LE(0xABCD5432, 32);
    b.write("18:02:11", 112); b.write("Sep 27 2026", 128);
    assert.deepEqual(fw.inspect(b), { ok: true, built: "Sep 27 2026 18:02:11" });
    assert.equal(fw.inspect(Buffer.alloc(400)).ok, false);
    b.writeUInt16LE(2, 12);
    assert.match(fw.inspect(b).error, /chip id 2/);
    const v = Buffer.from("\0abc\x001.0.2\0xyz", "latin1");
    assert.equal(fw.hasVersion(v, "1.0.2"), true);
    assert.equal(fw.hasVersion(v, "1.0"), false);
});
