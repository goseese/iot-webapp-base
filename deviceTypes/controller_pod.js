// Controller pod (DECISIONS.md "Pod stations"): runs a training station. It provisions and logs in
// to the broker like a gateway, publishes its own readings on dev/{guid}/data, and relays its target
// pods' ESP-NOW frames on dev/{guid}/frame as JSON ({ mac, rssi, model, fw, seq, data }), which go
// through the target pod's own type.
const pod = require("./shared/pod");

module.exports =
{
    slug: "controller_pod",
    displayName: "Controller pod",
    kind: "gateway",
    dedupMode: "none",
    minIntervalSecs: 0,
    models: ["vpod-ctl"],   // exact model string the firmware sends when provisioning
    fields: [],
    statusMap: {},
    dataMap: Object.assign({ wifi_rssi: "wifi-rssi" }, pod.dataMap),
    batteryChemistry: "li_ion",
    channels: pod.channels().concat(
    [
        { id: "signal", name: "WiFi signal", metric: "percent" },
        { id: "wifi-rssi", name: "WiFi RSSI", metric: "rssi", inboundUnit: "dBm", signal: "wifi" }
    ]),
    // pair_mode is set with the "Pair target pods" toggle on the controller's page, not on the Config
    // tab; it goes through the config write path so the page shows what the pod actually holds and a
    // pod that reconnects mid session gets it again. It stays on until someone turns it off.
    configKeys:
    {
        pair_mode: { label: "Pairing mode", kind: "bool", writable: true, description: "While on, a target pod whose button is held pairs with this controller. Use the Pair target pods button on the Station tab." },
        report_secs: pod.reportSecs,
        band_rssi_min: pod.bandRssiMin
    },
    commands: Object.assign({}, pod.commands,
    {
        reboot: Object.assign({}, pod.commands.reboot, { description: "The controller restarts. Its station is offline until it reconnects." })
    }),
    commandQueue: true,
    // This type runs stations: target pods pair with it (the target types list it in pairsWith).
    station: true,
    hooks: {}
};
