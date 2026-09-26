// Any gateway speaking gateway-protocol.md. Its own sensors come from the status topic; extra
// status fields are ignored, absent ones skip (gateway-protocol 4.4).
module.exports =
{
    slug: "gateway_generic",
    // Channel ids predate the naming standard (DECISIONS) and have live sensors; kept as they are.
    legacyChannelIds: true,
    displayName: "Gateway",
    kind: "gateway",
    dedupMode: "none",
    minIntervalSecs: 0,
    models: ["gw-cell-1", "gw-eth-1", "gw-wifi-1"],
    fields: [],
    statusMap:
    {
        vbat: "vbat",
        vin: "vin",
        temp_c: "temp",
        cell_rssi: "cell_rssi",
        uptime_s: "uptime",
        heap: "heap",
        online: "online"
    },
    channels:
    [
        { id: "online", name: "Online", metric: "boolean",
          defaultAlarms: [{ direction: "lower", threshold: 0.5, severity: "alarm", exceedSecs: 120, returnSecs: 60 }] },
        { id: "vbat", name: "Battery voltage", metric: "voltage", inboundUnit: "V",
          defaultAlarms: [{ direction: "lower", threshold: 3.5, severity: "warning", exceedSecs: 600, returnSecs: 600 }] },
        { id: "vin", name: "Input voltage", metric: "voltage", inboundUnit: "V",
          defaultAlarms: [{ direction: "lower", threshold: 10.5, severity: "warning", exceedSecs: 600, returnSecs: 600 }] },
        { id: "temp", name: "Board temperature", metric: "temperature", inboundUnit: "C" },
        { id: "cell_rssi", name: "Cellular signal", metric: "rssi", inboundUnit: "dBm" },
        { id: "uptime", name: "Uptime", metric: "duration", inboundUnit: "s", displayUnit: "h" },
        { id: "heap", name: "Free heap", metric: "data_size", inboundUnit: "B", displayUnit: "kB" }
    ],
    hooks: {}
};

// Every channel gets a 30 minute no-data rule (was the type level noDataTimeoutSecs: 1800).
for (const ch of module.exports.channels)
{
    ch.defaultAlarms = (ch.defaultAlarms || []).concat([{ rule: "no_data", timeoutSecs: 1800 }]);
}
