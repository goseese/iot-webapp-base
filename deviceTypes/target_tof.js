// Target pod, laser (DECISIONS.md "Pod stations"): senses a break in its laser beam (VL53L1).
// Talks ESP-NOW to one controller pod, which relays its frames; it never connects to the broker, so
// it is a node. Its first frame through a controller in pairing mode places it in that controller's
// location (pipeline/identify.js). Hits and reaction times are game results, not readings.
const pod = require("./shared/pod");

module.exports =
{
    slug: "target_tof",
    displayName: "Target pod, laser",
    namePrefix: "Laser target",    // default name on pairing: "Laser target 5678" (last four of the MAC)
    kind: "node",
    dedupMode: "counter",   // seq in the relayed frame
    minIntervalSecs: 0,
    models: ["vpod-tof"],
    fields: [],
    dataMap: pod.dataMap,
    batteryChemistry: "li_ion",
    channels: pod.channels().concat(
    [
        // What the controller measures of this pod: one sensor per controller (perGateway), from the
        // ESP-NOW receive RSSI. signal is the percent (wifi table: 2.4 GHz, same radio).
        { id: "rssi", name: "Signal to controller", metric: "rssi", inboundUnit: "dBm", perGateway: true, signal: "wifi" },
        { id: "signal", name: "Signal", metric: "percent", perGateway: true }
    ]),
    pairsWith: ["controller_pod"],
    // Sent through the controller it is paired with, as queued commands (services/commandQueue.js).
    configKeys: { report_secs: pod.reportSecs },
    commands: pod.commands,
    commandQueue: true,
    hooks: {}
};
