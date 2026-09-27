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

module.exports = { dataMap, channels };
