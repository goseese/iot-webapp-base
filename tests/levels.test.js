const test = require("node:test");
const assert = require("node:assert");
const levels = require("../services/levels");

test("battery percent follows the legacy tables", () =>
{
    assert.equal(levels.batteryPercent("cr2477", 3.2), 100);
    assert.equal(levels.batteryPercent("cr2477", 3.0), 100);
    assert.equal(levels.batteryPercent("cr2477", 2.85), 73);     // between 2.9 (85) and 2.8 (60)
    assert.equal(levels.batteryPercent("cr2477", 2.0), 1);
    assert.equal(levels.batteryPercent("alkaline_2s", 2.6), 55);
    assert.equal(levels.batteryPercent("li_ion", 3.8), 62);      // between 3.9 (75) and 3.7 (50): 62.4999 in floating point, as in PHP
    assert.equal(levels.batteryPercent("nope", 3.0), null);
    assert.equal(levels.batteryPercent("cr2477", 0), null);
});

test("signal percent follows the legacy tables", () =>
{
    assert.equal(levels.signalPercent("ble", -40), 100);
    assert.equal(levels.signalPercent("ble", -100), 18);         // between -95 (30) and -107 (1): 1 + 7/12 * 29
    assert.equal(levels.signalPercent("lora", -120), 48);
    assert.equal(levels.signalPercent("csq", 19), 51);
    assert.equal(levels.signalPercent("csq", 99), null);
    assert.equal(levels.signalPercent("csq", 5), 1);
    assert.equal(levels.signalPercent("wifi", -75), 51);
    assert.equal(levels.signalPercent("zigbee", -75), null);
    assert.equal(levels.signalPercent("ble", null), null);
});

test("pipeline adds battery and signal percent from declared channels", () =>
{
    const { addLevels } = require("../pipeline/levels");
    const types = require("../deviceTypes");
    // Stand-ins shaped like the removed gw7080 (V battery, li_ion, csq) and ble_s5 (mV battery,
    // cr2477, per gateway rssi), so the level math keeps its coverage until the pod types exist.
    const gw =
    {
        slug: "test_gateway", batteryChemistry: "li_ion",
        channels:
        [
            { id: "int-vbat", name: "Battery voltage", metric: "voltage", inboundUnit: "V" },
            { id: "int-vbat-pct", name: "Battery", metric: "percent" },
            { id: "signal", name: "Signal", metric: "percent" },
            { id: "csq", name: "Cellular signal (CSQ)", metric: "count", signal: "csq" }
        ]
    };
    const s5 =
    {
        slug: "test_beacon", batteryChemistry: "cr2477",
        channels:
        [
            { id: "int-vbat", name: "Battery voltage", metric: "voltage", inboundUnit: "mV" },
            { id: "int-vbat-pct", name: "Battery", metric: "percent" },
            { id: "signal", name: "Signal", metric: "percent", perGateway: true },
            { id: "rssi", name: "RSSI", metric: "rssi", inboundUnit: "dBm", perGateway: true, signal: "ble" },
            { id: "heard-count", name: "Heard Count", metric: "count", perGateway: true }
        ]
    };
    const defOf = (t) => (c) => types.channelDef(t, c);
    const none = new Map();

    // Gateway: V inbound, li_ion default, csq -> signal.
    let out = addLevels({ device: {}, type: gw, values: { "int-vbat": 3.8, "csq": 19 } }, gw, none, defOf(gw)).values;
    assert.equal(out["int-vbat-pct"], 62);
    assert.equal(out["signal"], 51);

    // Beacon: mV inbound, cr2477 default; a device override wins.
    out = addLevels({ device: {}, type: s5, values: { "int-vbat": 2850 } }, s5, none, defOf(s5)).values;
    assert.equal(out["int-vbat-pct"], 73);
    out = addLevels({ device: { battery_chemistry: "alkaline_2s" }, type: s5, values: { "int-vbat": 2600 } }, s5, none, defOf(s5)).values;
    assert.equal(out["int-vbat-pct"], 55);

    // Per gateway rssi (canonical, as a relaying gateway sends it) -> per gateway signal with the same suffix.
    out = addLevels({ device: {}, type: s5, values: { "rssi-72:b4": -100, "heard-count-72:b4": 5 }, canonical: true }, s5, none, defOf(s5)).values;
    assert.equal(out["signal-72:b4"], 18);
    assert.equal(out["int-vbat-pct"], undefined);

    // Types without the channels get nothing added.
    const srv = types.get("platform_server");
    out = addLevels({ device: {}, type: srv, values: { "heap_used": 5 } }, srv, none, defOf(srv)).values;
    assert.deepEqual(out, { "heap_used": 5 });
});
