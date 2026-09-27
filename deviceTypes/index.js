// One module per device type slug; the device_types table is a shadow (architecture 3.2).
const fs = require("fs");
const path = require("path");
const metrics = require("../metrics");
const levels = require("../services/levels");

// Channel ids follow the naming standard in DECISIONS ("Channel naming standard"): lower case words
// joined by hyphens, named for what the reading is on any device (int-vbat, int-temp, ext-temp-1).
// Types written before the standard set legacyChannelIds: true and keep their ids.
const CHANNEL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const types = {};
for (const file of fs.readdirSync(__dirname))
{
    if (file === "index.js" || !file.endsWith(".js")) { continue; }
    const t = require(path.join(__dirname, file));
    validate(t);
    types[t.slug] = t;
}

function validate(t)
{
    const kinds = ["gateway", "node", "beacon", "direct", "asset"];
    if (!kinds.includes(t.kind)) { throw new Error("device type " + t.slug + ": bad kind " + t.kind); }
    if (!["counter", "window", "none"].includes(t.dedupMode)) { throw new Error("device type " + t.slug + ": bad dedupMode"); }
    if (t.batteryChemistry !== undefined && !levels.BATTERY[t.batteryChemistry])
    {
        throw new Error("device type " + t.slug + ": unknown batteryChemistry " + t.batteryChemistry);
    }
    for (const ch of t.channels)
    {
        if (!t.legacyChannelIds && !CHANNEL_ID.test(ch.id))
        {
            throw new Error("device type " + t.slug + " channel " + ch.id + ": ids are lower case words joined by hyphens (DECISIONS, channel naming standard)");
        }
        if (ch.signal !== undefined && !levels.SIGNAL[ch.signal])
        {
            throw new Error("device type " + t.slug + " channel " + ch.id + ": unknown signal type " + ch.signal);
        }
        metrics.get(ch.metric);
        if (ch.inboundUnit && ch.inboundUnit !== metrics.get(ch.metric).canonical && !metrics.get(ch.metric).units[ch.inboundUnit])
        {
            throw new Error("device type " + t.slug + " channel " + ch.id + ": metric " + ch.metric + " has no unit " + ch.inboundUnit);
        }
        if (ch.noDataTimeoutSecs !== undefined)
        {
            throw new Error("device type " + t.slug + " channel " + ch.id + ": noDataTimeoutSecs is replaced by a defaultAlarms entry { rule: \"no_data\", timeoutSecs }");
        }
        for (const a of (ch.defaultAlarms || []))
        {
            const ok = a.rule === "no_data" ? a.timeoutSecs > 0 : (a.direction === "lower" || a.direction === "upper") && Number.isFinite(a.threshold);
            if (!ok) { throw new Error("device type " + t.slug + " channel " + ch.id + ": bad default alarm " + JSON.stringify(a)); }
        }
    }
    for (const [key, def] of Object.entries(t.configKeys || {}))
    {
        if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) { throw new Error("device type " + t.slug + ": bad config key " + key); }
        if (!["string", "int", "float", "bool", "hexlist"].includes(def.kind)) { throw new Error("device type " + t.slug + " config " + key + ": bad kind " + def.kind); }
    }
    if (t.noDataTimeoutSecs !== undefined)
    {
        throw new Error("device type " + t.slug + ": type level noDataTimeoutSecs is gone; declare no-data per channel in defaultAlarms");
    }
}

function get(slug)
{
    const t = types[slug];
    if (!t) { throw new Error("unknown device type " + slug); }
    return t;
}

function forModel(model)
{
    return Object.values(types).find((t) => (t.models || []).includes(model)) || null;
}

// Readings a gateway takes of a device it hears (RSSI, heard count, signal). A channel declared
// perGateway: true gets one sensor per hearing gateway, the legacy naming: id "{id}-{last two bytes
// of the gateway MAC, lower case}", name "{name} {LAST TWO BYTES}", e.g. gateway A846749F72B4 gives
// rssi-72:b4 / "RSSI 72:B4". Any other channel keeps its plain id. Null when the gateway has no
// usable MAC.
function gatewayChannelId(type, id, gatewayMac)
{
    const def = type.channels.find((c) => c.id === id);
    if (!def || !def.perGateway) { return id; }
    const mac = String(gatewayMac || "").replace(/[^0-9a-fA-F]/g, "");
    if (mac.length < 4) { return null; }
    const last4 = mac.slice(-4).toLowerCase();
    return id + "-" + last4.slice(0, 2) + ":" + last4.slice(2);
}

// { id: value } -> { stored channel id: value } for gatewayChannelId, dropping empty values.
function gatewayValues(type, gatewayMac, values)
{
    const out = {};
    for (const [id, v] of Object.entries(values))
    {
        if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) { continue; }
        const key = gatewayChannelId(type, id, gatewayMac);
        if (key) { out[key] = Number(v); }
    }
    return out;
}

// Channel definition for a stored channel id, including the per gateway form above (a copy of the
// declared channel with the stored id and suffixed name; base is the declared channel).
function channelDef(type, channelId)
{
    const exact = type.channels.find((c) => c.id === channelId);
    if (exact) { return exact; }
    const m = /^(.+)-([0-9a-f]{2}:[0-9a-f]{2})$/.exec(String(channelId));
    if (!m) { return null; }
    const base = type.channels.find((c) => c.id === m[1] && c.perGateway);
    if (!base) { return null; }
    return Object.assign({}, base, { id: channelId, name: base.name + " " + m[2].toUpperCase(), base: base });
}

module.exports = { all: types, get, forModel, gatewayChannelId, gatewayValues, channelDef };
