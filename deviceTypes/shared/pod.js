// Shared by the pod device types (DECISIONS.md "Pod stations"). Controller, account and target pods
// share one PCB (ESP32-S3, SHTC3, 12 V in with a Li-Ion 4.2 V backup cell, the same as the standard
// gateway), so their own readings use the same firmware keys and channels. The keys are the
// standard gateway's publish keys, so firmware code carries over.
//
// Firmware key -> channel id (the naming standard, DECISIONS). Nulls skip; unknown keys are ignored.
const dataMap =
{
    vin: "vin",
    vbat: "int-vbat",
    charge_state: "charge-state",
    int_temp: "int-temp",
    int_hum: "int-humidity",
    run_time: "run-time",
    free_heap: "free-heap"
};

// No default alarms on pods for now (Jeff, Sep 2026).
function channels()
{
    return [
        { id: "vin", name: "Power in", metric: "voltage", inboundUnit: "V", description: "The 12 V supply. Near zero means the pod is running on its backup battery." },
        { id: "int-vbat", name: "Battery voltage", metric: "voltage", inboundUnit: "V" },
        { id: "int-vbat-pct", name: "Battery", metric: "percent" },
        { id: "charge-state", name: "Charge state", metric: "count" },
        { id: "int-temp", name: "Board temperature", metric: "temperature", inboundUnit: "C" },
        { id: "int-humidity", name: "Board humidity", metric: "humidity", inboundUnit: "%" },
        { id: "run-time", name: "Uptime", metric: "duration", inboundUnit: "min", displayUnit: "h" },
        { id: "free-heap", name: "Free heap", metric: "data_size", inboundUnit: "B", displayUnit: "kB" }
    ];
}

// report_secs on every pod (pod-protocol.md section 4). A controller or account pod takes it on
// the Config tab like any gateway key; a target pod's goes through its controller as a queued
// set_config command (services/commandQueue.js), confirmed by the ack.
const reportSecs = { label: "Report interval", kind: "int", min: 60, max: 86400, writable: true, description: "Seconds between readings. The pod's default is 600 (10 minutes)." };

// band_rssi_min on controllers and account pods (pod-protocol.md sections 4 and 8): the firmware
// ignores wristbands heard weaker than this, so only a band held up to the pod checks in.
const bandRssiMin = { label: "Wristband minimum signal", kind: "int", min: -100, max: -20, writable: true, description: "dBm. Bands heard weaker than this are ignored. The pod's default is -50." };

// Commands (pod-protocol.md section 5.4). Every pod type sets commandQueue: true, so these are
// queued and acked rather than published straight to the pod. value "color" makes the Commands tab
// offer the LED colors below.
const commands =
{
    led:         { label: "LED color", permission: "edit", confirm: false, value: "color", description: "Sets the whole LED grid to one color." },
    publish_now: { label: "Get data", permission: "view", confirm: false, cooldownSecs: 60, description: "The pod sends its current readings." },
    reboot:      { label: "Reboot", permission: "edit", confirm: true, cooldownSecs: 120, description: "The pod restarts." }
};

const LED_COLORS = [["FF0000", "Red"], ["00FF00", "Green"], ["0000FF", "Blue"], ["FFFF00", "Yellow"], ["FFFFFF", "White"], ["off", "Off"]];

module.exports = { dataMap, channels, reportSecs, bandRssiMin, commands, LED_COLORS };
