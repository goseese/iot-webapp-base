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
    commands:
    {
        publish_now: { label: "Get data", permission: "view", confirm: false, cooldownSecs: 60, description: "The pod publishes its current readings." },
        reboot:      { label: "Reboot", permission: "edit", confirm: true, cooldownSecs: 120, description: "The pod restarts." }
    },
    hooks: {}
};
