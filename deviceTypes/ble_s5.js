// S5 BLE sensor beacon (ported Sep 2026 from the legacy PHP model devices/ble_s5.php).
//
// Heard by a gateway and relayed one beacon per publish on dev/{guid}/ble (DECISIONS "BLE uplink is
// one beacon per publish"); pipeline/identify.handleBle hands the advertisement bytes to
// parseAdvertisement below. The bytes start at the Eddystone service UUID:
//
//   AA FE        Eddystone service UUID (0xFEAA, little endian)
//   21           frame type, 0x21 = custom Eddystone (0x20 would be standard TLM)
//   04 | 00      version: 04 = vbat, temp, humidity, x, y, z, cycles; 00 = vbat, temp, x, y, z
//   nn           length (not checked: 0x0F on a v04 sample with 15 data bytes, 0x0B on a v00
//                sample with 10)
//   data         big endian:
//     v04  0 vbat mV u16 | 2 temp 8.8 | 4 humidity 8.8 | 6 x mg i16 | 8 y | 10 z | 12 unused | 13 cycles u16
//     v00  0 vbat mV u16 | 2 temp 8.8 | 4 x mg i16 | 6 y | 8 z
//
// The PHP read x, y, z by swapping two hex bytes and unpacking little endian, which is a big endian
// int16; its comment block shows the offsets one byte off, the code is what is ported. Samples:
//   AAFE21040F 0BE2 17FC 3C03 FD68 FE4C 024C 01 0ECF  -> 3.042 V, 23.98 C, 60.0 %, -0.664/-0.436/0.588 g, 3791
//   AAFE21000B 0E3F 1400 0010 000C 03F8               -> 3.647 V, 20.00 C, 0.016/0.012/1.016 g
// Temperature 8.8 is two's complement, int16 / 256. Checked against the legacy helper
// fixed8_8_to_decimal(): it forms the signed int16, then adds (c >> 8) and (c & 0xFF) / 256, which
// is exactly c / 256 for negative values too (0xFF80 -> -1 + 0.5 = -0.5).
function parseAdvertisement(adv)
{
    if (!Buffer.isBuffer(adv) || adv.length < 5 || adv[0] !== 0xAA || adv[1] !== 0xFE || adv[2] !== 0x21)
    {
        return null;
    }
    const ver = adv[3];
    const d = adv.subarray(5);
    if (ver === 0x04 && d.length >= 15)
    {
        return {
            "int-vbat": d.readUInt16BE(0),
            "int-temp": d.readInt16BE(2) / 256,
            "int-humidity": d.readUInt16BE(4) / 256,
            "acc-x": d.readInt16BE(6),
            "acc-y": d.readInt16BE(8),
            "acc-z": d.readInt16BE(10),
            "cycles": d.readUInt16BE(13)
        };
    }
    if (ver === 0x00 && d.length >= 10)
    {
        return {
            "int-vbat": d.readUInt16BE(0),
            "int-temp": d.readInt16BE(2) / 256,
            "acc-x": d.readInt16BE(4),
            "acc-y": d.readInt16BE(6),
            "acc-z": d.readInt16BE(8)
        };
    }
    return null;
}

module.exports =
{
    slug: "ble_s5",
    displayName: "S5 BLE sensor beacon",
    kind: "beacon",
    // Gateways relay every beacon they hear each BLE publish interval; several gateways can hear one
    // beacon, so readings within a minute of each other are one observation.
    dedupMode: "window",
    minIntervalSecs: 60,
    models: [],
    fields: [],
    statusMap: {},
    parseAdvertisement: parseAdvertisement,
    // Default for int-vbat-pct (services/levels.js); a device can override it on its Settings tab.
    batteryChemistry: "cr2477",
    // Channel ids follow the naming standard (DECISIONS). Legacy ewma-temp and heat-index were
    // computed on the server and are not ported here.
    channels:
    [
        { id: "int-vbat", name: "Battery voltage", metric: "voltage", inboundUnit: "mV" },
        { id: "int-vbat-pct", name: "Battery", metric: "percent" },                               // from int-vbat and the chemistry
        { id: "int-temp", name: "Temperature", metric: "temperature", inboundUnit: "C" },
        { id: "int-humidity", name: "Humidity", metric: "humidity", inboundUnit: "%" },           // v04 only
        { id: "acc-x", name: "Acc X", metric: "acceleration", inboundUnit: "mg" },
        { id: "acc-y", name: "Acc Y", metric: "acceleration", inboundUnit: "mg" },
        { id: "acc-z", name: "Acc Z", metric: "acceleration", inboundUnit: "mg" },
        { id: "cycles", name: "Power on cycles", metric: "count" },                               // legacy newTHCnt, v04 only
        // From the ble envelope, not the advertisement: one sensor per hearing gateway (perGateway),
        // e.g. rssi-72:b4 "RSSI 72:B4". signal is the percent from rssi (ble table); heard-count is
        // how often that gateway heard the beacon in its publish cycle (legacy gw-count "Pub Count").
        { id: "signal", name: "Signal", metric: "percent", perGateway: true },
        { id: "rssi", name: "RSSI", metric: "rssi", inboundUnit: "dBm", perGateway: true, signal: "ble" },
        { id: "heard-count", name: "Heard Count", metric: "count", perGateway: true }
    ]
};
