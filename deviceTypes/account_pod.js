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
    firmwareImage: "volta-pod-ctl",   // storage/firmware/volta-pod-ctl/firmware.bin (services/firmware.js)
    fields: [],
    statusMap: {},
    dataMap: Object.assign({ wifi_rssi: "wifi-rssi", wifi_channel: "wifi-channel" }, pod.dataMap),
    batteryChemistry: "li_ion",
    channels: pod.channels().concat(
    [
        { id: "signal", name: "WiFi signal", metric: "percent" },
        { id: "wifi-rssi", name: "WiFi RSSI", metric: "rssi", inboundUnit: "dBm", signal: "wifi" },
        { id: "wifi-channel", name: "WiFi channel", metric: "count", description: "The access point channel. A controller that hops channels forces its target pods to re-find it." }
    ]),
    configKeys: { report_secs: pod.reportSecs, band_rssi_min: pod.bandRssiMin },
    commands: pod.commands,
    commandQueue: true,
    // Wristbands presented to it are being enrolled (services/athletes.js); its page shows the last one.
    enrolls: true,
    hooks: {}
};
