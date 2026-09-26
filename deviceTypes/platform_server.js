// The platform's own health as a device: fed by the minute job through pipeline step 2,
// so server stats get charts and alarm limits like any sensor. One per install, in
// the System account / server location. Channel descriptions show on each sensor's
// Overview unless the sensor has its own.
module.exports =
{
    slug: "platform_server",
    // Channel ids predate the naming standard (DECISIONS) and have live sensors; kept as they are.
    legacyChannelIds: true,
    displayName: "Platform server",
    kind: "direct",
    dedupMode: "none",
    minIntervalSecs: 60,
    models: [],
    fields: [],            // no frame parsing: readings arrive as { channel: value } objects
    channels:
    [
        { id: "http_response_ms", name: "HTTP response time", metric: "duration", inboundUnit: "ms", displayUnit: "ms",
          description: "Time for the leader to fetch its own /health page through the public site address, so it includes IIS, ARR and the network path, not just Node.\n\nMeasured once a minute. A timeout records 5000 ms.",
          defaultAlarms: [{ direction: "upper", threshold: 2.0, severity: "warning", exceedSecs: 300, returnSecs: 300 }] },
        { id: "db_query_ms", name: "Database query time", metric: "duration", inboundUnit: "ms", displayUnit: "ms",
          description: "Time for one small query (a count of the settings table) from the leader to SQL Server.\n\nA rising value points at database load, locking or the network between the app servers and SQL Server.",
          defaultAlarms: [{ direction: "upper", threshold: 1.0, severity: "warning", exceedSecs: 300, returnSecs: 300 }] },
        { id: "ingest_lag_secs", name: "Ingest lag", metric: "duration", inboundUnit: "s",
          description: "How long the most recent MQTT message took from arriving at the leader to finishing the pipeline (identify, store, alarms, publish).\n\nMessages are processed one at a time, so a slow database or a burst of messages makes this climb.\n\nIt only updates when a message is processed. With no traffic it keeps the last value, so a low number can also mean nothing has arrived lately; check Broker connected and gateway last seen times.",
          defaultAlarms: [{ direction: "upper", threshold: 120, severity: "alarm", exceedSecs: 120, returnSecs: 120 }] },
        { id: "mqtt_connected", name: "Broker connected", metric: "boolean",
          description: "Whether the leader's ingest client is connected to the MQTT broker. While this is No, no device data is being received.",
          defaultAlarms: [{ direction: "lower", threshold: 0.5, severity: "alarm", exceedSecs: 120, returnSecs: 60 }] },
        { id: "event_loop_lag_ms", name: "Event loop lag", metric: "duration", inboundUnit: "ms", displayUnit: "ms",
          description: "How long Node takes to get back to a task it just queued. Node runs the app's JavaScript on one thread, so this shows whether that thread is busy.\n\nNormal is 0 to a few ms. A steady tens or hundreds of ms means something is holding the thread (a large synchronous loop, heavy JSON work, a big report), and every web request and MQTT message on that process waits behind it.\n\nSampled once a minute, so it catches sustained stalls, not short spikes." },
        { id: "heap_used", name: "Heap used", metric: "data_size", inboundUnit: "B", displayUnit: "MB",
          description: "Memory holding JavaScript objects in the leader's Node process (process.memoryUsage().heapUsed).\n\nThis is part of the process's RAM, not all of it: Node's runtime, buffers and native modules are extra, so Task Manager shows a larger number. It says nothing about the server's total or free RAM.\n\nA heap that rises steadily over days and never drops back suggests a memory leak." },
        { id: "active_alarms", name: "Active alarms", metric: "count",
          description: "Number of uncleared alarms across every account on this install." }
    ],
    defaultTags: ["dashboard"],
    hooks: {}
};

// Every channel gets a 5 minute no-data rule (was the type level noDataTimeoutSecs: 300).
for (const ch of module.exports.channels)
{
    ch.defaultAlarms = (ch.defaultAlarms || []).concat([{ rule: "no_data", timeoutSecs: 300 }]);
}
