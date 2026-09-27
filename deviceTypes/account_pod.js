// Account pod (DECISIONS.md "Pod stations"): the same hardware as a controller pod, used to sign
// athletes in for detailed stats. It provisions and logs in to the broker like a gateway and runs no
// station.
const pod = require("./shared/pod");

module.exports =
{
    slug: "account_pod",
    displayName: "Account pod",
    kind: "gateway",
    dedupMode: "none",
    minIntervalSecs: 0,
    models: ["vpod-acct"],
    fields: [],
    statusMap: {},
    dataMap: Object.assign({ wifi_rssi: "wifi-rssi" }, pod.dataMap),
    batteryChemistry: "li_ion",
    channels: pod.channels().concat(
    [
        { id: "signal", name: "WiFi signal", metric: "percent" },
        { id: "wifi-rssi", name: "WiFi RSSI", metric: "rssi", inboundUnit: "dBm", signal: "wifi" }
    ]),
    configKeys: { report_secs: pod.reportSecs },
    commands: pod.commands,
    commandQueue: true,
    hooks: {}
};
