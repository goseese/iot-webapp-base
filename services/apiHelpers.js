// Pure helpers for routes/api.js (DECISIONS "API detail endpoints", "API range paging"), kept apart
// so they test without a database.

const SEVERITY_ORDER = ["info", "warning", "alarm", "emergency"];

// The worse of two alarm statuses: "ok" or a severity.
function worse(a, b)
{
    if (a === "ok") { return b; }
    if (b === "ok") { return a; }
    return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;
}

// Rows arrive oldest first and limit + 1 are fetched. When there are more, the page stops before the
// epoch it could not finish, and next_from is that epoch, so asking again with from = next_from neither
// skips nor repeats a row. A whole page inside one second cannot be split; next_from moves past it.
function pageByEpoch(rows, limit, key)
{
    if (rows.length <= limit) { return { rows: rows, truncated: false, next_from: null }; }
    const cut = Number(rows[limit][key]);
    const page = rows.slice(0, limit).filter((r) => Number(r[key]) < cut);
    if (page.length) { return { rows: page, truncated: true, next_from: cut }; }
    return { rows: rows.slice(0, limit), truncated: true, next_from: cut + 1 };
}

// A limit query parameter: whole number, at least 1, at most max; anything else is the default.
function limitOf(v, def, max)
{
    const n = Math.floor(Number(v));
    return Math.min(Number.isFinite(n) && n >= 1 ? n : def, max);
}

function parseJson(v)
{
    try
    {
        return v ? JSON.parse(v) : null;
    }
    catch (err)
    {
        return null;
    }
}

// An audit_log value (always text) back to its type, by the field it belongs to
// (services/alarms/ruleLog.js FIELDS; booleans are stored as 1 and 0).
function typedValue(field, v)
{
    if (v === null || v === undefined) { return null; }
    if (["threshold", "exceed_secs", "return_secs", "timeout_secs", "chart_window_secs"].includes(field)) { return Number(v); }
    if (field === "is_enabled" || field === "use_default_group" || field === "chart_in_alarm") { return v === "1" || v === "true"; }
    if (field === "channel_policy") { return parseJson(v); }
    if (field === "created" || field === "deleted")
    {
        // A whole rule snapshot: every field typed as above; reason, when present, stays text.
        const snap = parseJson(v);
        if (!snap || typeof snap !== "object") { return snap; }
        const out = {};
        for (const k of Object.keys(snap)) { out[k] = typeof snap[k] === "string" ? typedValue(k, snap[k]) : snap[k]; }
        return out;
    }
    return v;
}

// The scope a list endpoint requires (DECISIONS "API queries are scoped"): at least one of allowed must
// be given. Returns the error text for the 400, or null when one is present.
function missingScope(query, allowed)
{
    const q = query || {};
    if (allowed.some((k) => q[k] !== undefined && q[k] !== null && String(q[k]) !== "")) { return null; }
    if (allowed.length === 1) { return allowed[0] + " is required (a uid)."; }
    return "One of " + allowed.slice(0, -1).join(", ") + " or " + allowed[allowed.length - 1] + " is required (a uid).";
}

// A minutes query parameter: a whole number from 1 to ten years of minutes; anything else is null (a 400).
function minutesOf(v)
{
    if (v === undefined || v === null || String(v).trim() === "") { return null; }
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 5256000 ? n : null;
}

// A yes or no query parameter: 1, true or yes, and 0, false or no, in any case. Absent or anything else is def.
function flagOf(v, def)
{
    const s = String(v === undefined || v === null ? "" : v).trim().toLowerCase();
    if (["1", "true", "yes"].includes(s)) { return true; }
    if (["0", "false", "no"].includes(s)) { return false; }
    return def;
}

module.exports = { SEVERITY_ORDER, worse, pageByEpoch, limitOf, parseJson, typedValue, missingScope, minutesOf, flagOf };
