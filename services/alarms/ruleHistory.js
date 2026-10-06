// Alarm rule change log, read back (ALARM_TITLES_AND_RULE_LOG_README.md Part B). Turns audit_log
// rows written by ruleLog.js into lines a person reads: { epoch, who, what, before, after }.
// The sensor's rules page and the API word a change the same way through this module.
// Values are stored as the database holds them; fmt.threshold(v) converts a canonical threshold
// to the page's display unit with its unit.

const LABELS =
{
    rule_kind: "Kind",
    direction: "Direction",
    threshold: "Threshold",
    severity: "Severity",
    exceed_secs: "Exceed delay",
    return_secs: "Return delay",
    timeout_secs: "No data timeout",
    is_enabled: "Enabled",
    use_default_group: "Default group",
    channel_policy: "Channels",
    alert_groups: "Alert groups",
    alarm_title: "Alarm title"
};
const TRANSITIONS = [["raise", "Raise"], ["escalate", "Escalate"], ["de_escalate", "De-escalate"], ["clear", "Clear"]];

function blank(v)
{
    return v === null || v === undefined || v === "";
}

function who(row)
{
    if (row.actor_type === "system") { return "System"; }
    if (row.actor_type === "api_credential") { return "API key " + (row.actor_name || ""); }
    return row.actor_name || "unknown";
}

function minutes(v)
{
    return blank(v) ? "--" : Math.round(Number(v) / 60) + " min";
}

function onOff(v)
{
    return v === "1" ? "on" : v === "0" ? "off" : "--";
}

// "Raise email, Escalate off, ..." per transition, channels joined with +.
function policy(v)
{
    let p;
    try
    {
        p = JSON.parse(v);
    }
    catch (err)
    {
        return String(v);
    }
    return TRANSITIONS.map((t) =>
    {
        const c = p[t[0]] || {};
        const on = [];
        if (c.email !== false) { on.push("email"); }
        if (c.sms !== false) { on.push("SMS"); }
        return t[1] + " " + (on.length ? on.join("+") : "off");
    }).join(", ");
}

function value(field, v, fmt)
{
    if (blank(v)) { return field === "alert_groups" ? "none" : "--"; }
    switch (field)
    {
        case "threshold": return fmt && fmt.threshold ? fmt.threshold(v) : String(v);
        case "direction": return v === "upper" ? "Above" : v === "lower" ? "Below" : String(v);
        case "rule_kind": return v === "no_data" ? "No data" : "Threshold";
        case "exceed_secs":
        case "return_secs":
        case "timeout_secs": return minutes(v);
        case "is_enabled":
        case "use_default_group": return onOff(v);
        case "channel_policy": return policy(v);
        default: return String(v);
    }
}

// A whole rule snapshot (the JSON on a created or deleted row) in one line:
// "Above 46.4 F, alarm, exceed 5 min, return 5 min, groups: Night crew (device type default)".
function summary(json, fmt)
{
    let s;
    try
    {
        s = typeof json === "string" ? JSON.parse(json) : (json || {});
    }
    catch (err)
    {
        return String(json);
    }
    const parts = [];
    if (s.rule_kind === "no_data")
    {
        parts.push("No data " + minutes(s.timeout_secs));
        parts.push(s.severity);
    }
    else
    {
        parts.push(value("direction", s.direction) + " " + value("threshold", s.threshold, fmt));
        parts.push(s.severity);
        parts.push("exceed " + minutes(s.exceed_secs));
        parts.push("return " + minutes(s.return_secs));
    }
    if (s.is_enabled === "0") { parts.push("disabled"); }
    if (s.use_default_group === "0") { parts.push("no default group"); }
    if (!blank(s.alert_groups)) { parts.push("groups: " + s.alert_groups); }
    if (!blank(s.alarm_title)) { parts.push("title: " + s.alarm_title); }
    return parts.filter((p) => !blank(p)).join(", ") + (s.reason ? " (" + s.reason + ")" : "");
}

function line(row, fmt)
{
    const out = { epoch: Number(row.epoch), who: who(row), what: "", before: "", after: "", field: row.field };
    if (row.field === "created")
    {
        out.what = "Created";
        out.after = summary(row.new_value, fmt);
    }
    else if (row.field === "deleted")
    {
        out.what = "Deleted";
        out.before = summary(row.old_value, fmt);
    }
    else
    {
        out.what = LABELS[row.field] || row.field;
        out.before = value(row.field, row.old_value, fmt);
        out.after = value(row.field, row.new_value, fmt);
    }
    return out;
}

// Audit rows for these rule uids (live and deleted), newest first, bounded.
async function rowsFor(ruleUids, limit)
{
    if (!ruleUids.length) { return []; }
    const { knex, T } = require("../../db/knex");
    return knex(T("audit_log")).where({ entity_type: "alarm_rule" }).whereIn("entity_uid", ruleUids.map((u) => String(u).toLowerCase()))
        .orderBy([{ column: "epoch", order: "desc" }, { column: "id", order: "desc" }]).limit(limit || 1000);
}

// rowsFor() grouped by rule uid as lines, newest first.
function byRule(rows, fmt)
{
    const map = new Map();
    for (const r of rows)
    {
        const k = String(r.entity_uid).toLowerCase();
        if (!map.has(k)) { map.set(k, []); }
        map.get(k).push(line(r, fmt));
    }
    return map;
}

module.exports = { LABELS, who, value, summary, line, rowsFor, byRule };
