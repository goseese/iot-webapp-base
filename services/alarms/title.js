// Alarm title (ALARM_TITLES_AND_RULE_LOG_README.md Part A). One line per alarm, used for the email
// subject after the event word, the first line of the SMS and the API alarm `name`. Never build a
// subject anywhere else. The template comes from the first non blank level, most specific first:
// alarm rule, sensor, device, location, account, the ALARM_TITLE_FORMAT site setting, FALLBACK.

const FALLBACK = "{sensor_name} on {device_name} at {location_name}";
const DIRECTION_WORDS = { upper: "above", lower: "below", no_data: "no data" };
const TOKENS = ["site_name", "account_name", "location_name", "device_name", "sensor_name", "severity", "direction", "alarm_limit", "exceed_value", "return_value", "exceed_duration", "return_duration"];

// One line of help per token, shown in the Tokens list on the forms and in the API docs.
const TOKEN_HELP =
{
    site_name: "Site name",
    account_name: "Account name",
    location_name: "Location name",
    device_name: "Device name",
    sensor_name: "Sensor name",
    severity: "Current severity, e.g. alarm",
    direction: "above, below or no data",
    alarm_limit: "Rule threshold with unit, or no data",
    exceed_value: "Reading that raised the alarm",
    return_value: "Reading when it cleared, blank until then",
    exceed_duration: "Exceed delay (no data: the timeout) in words",
    return_duration: "Return delay in words"
};

// Example values for the preview line under a title field; pages override the names they know.
const SAMPLE =
{
    account_name: "Volta", location_name: "Main", device_name: "Server", sensor_name: "CPU temp",
    severity: "alarm", direction: "above", alarm_limit: "80.0 C", exceed_value: "82.5 C", return_value: "71.0 C",
    exceed_duration: "5 minutes", return_duration: "5 minutes"
};

// Levels in override order, most specific first, and how the forms name them.
const CHAIN = ["rule", "sensor", "device", "location", "account", "site"];
const SOURCE_TEXT = { rule: "alarm rule", sensor: "sensor", device: "device", location: "location", account: "account", site: "site default", default: "built in default" };

// levels: [{ source, template }] most specific first. White space only counts as blank.
function pick(levels)
{
    for (const l of levels)
    {
        const t = l.template === null || l.template === undefined ? "" : String(l.template).trim();
        if (t) { return { source: l.source, template: t }; }
    }
    return { source: "default", template: FALLBACK };
}

// Unknown tokens stay as typed so a typo shows in the first subject; known tokens with no value
// render blank. The result is one line: line breaks and runs of white space become one space.
function render(template, vars)
{
    const out = String(template).replace(/\{([a-z_]+)\}/g, (whole, name) =>
    {
        if (!Object.prototype.hasOwnProperty.call(vars, name)) { return whole; }
        const v = vars[name];
        return v === null || v === undefined ? "" : String(v);
    });
    return out.replace(/\s+/g, " ").trim();
}

// Seconds in words, largest units first: 5400 is "1 hour 30 minutes". Unset is blank.
function duration(secs)
{
    if (secs === null || secs === undefined || secs === "") { return ""; }
    let s = Math.round(Number(secs));
    if (!Number.isFinite(s) || s < 0) { return ""; }
    if (s === 0) { return "0 seconds"; }
    const parts = [];
    for (const [name, size] of [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]])
    {
        const n = Math.floor(s / size);
        if (n > 0)
        {
            parts.push(n + " " + name + (n === 1 ? "" : "s"));
            s -= n * size;
        }
    }
    return parts.join(" ");
}

// Token values. ctx is the alarm joined to its sensor, device, location and account
// (db/repos/alarms.context). rule is the alarm's rule row or null. formatted carries values
// already in the display unit: { site_name, alarm_limit, exceed_value, return_value }.
function tokens(ctx, rule, formatted)
{
    const f = formatted || {};
    const noData = ctx.direction === "no_data" || (rule && rule.rule_kind === "no_data");
    const vars =
    {
        site_name: f.site_name,
        account_name: ctx.account_name,
        location_name: ctx.location_name,
        device_name: ctx.device_name,
        sensor_name: ctx.sensor_name,
        severity: ctx.severity,
        direction: noData ? "no data" : (DIRECTION_WORDS[ctx.direction] || ctx.direction),
        alarm_limit: noData ? "no data" : f.alarm_limit,
        exceed_value: noData ? "" : f.exceed_value,
        return_value: noData ? "" : f.return_value,
        exceed_duration: "",
        return_duration: ""
    };
    if (rule)
    {
        vars.exceed_duration = duration(noData ? rule.timeout_secs : rule.exceed_secs);
        vars.return_duration = noData ? "" : duration(rule.return_secs);
    }
    return vars;
}

// The save cleaner for every title field: one line, trimmed, 200 characters, blank is NULL (inherit).
function clean(v)
{
    return String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

// The title for one alarm. ctx is db/repos/alarms.context (it carries sensor_alarm_title and
// device_alarm_title); rule is the alarm's rule row, a soft deleted one included, or null.
// Location and account titles come through the scoped settings cache in services/display.js
// (60 s), so list pages make no per row queries for them. Values use the same display unit
// lookup as the pages and the API. The return value is read only when the chosen template uses it.
async function forAlarm(ctx, rule)
{
    const settings = require("../../config/settings");
    const display = require("../display");
    const { knex, T } = require("../../db/knex");
    const ls = await display.scoped("location_settings", "location_id", ctx.location_id);
    const as = await display.scoped("account_settings", "account_id", ctx.account_id);
    const chosen = pick(
    [
        { source: "rule", template: rule ? rule.alarm_title : null },
        { source: "sensor", template: ctx.sensor_alarm_title },
        { source: "device", template: ctx.device_alarm_title },
        { source: "location", template: ls.ALARM_TITLE_FORMAT },
        { source: "account", template: as.ALARM_TITLE_FORMAT },
        { source: "site", template: settings.get("ALARM_TITLE_FORMAT", "") }
    ]);
    const sensor = { metric: ctx.metric, display_unit: ctx.display_unit, display_precision: ctx.display_precision };
    const location = { id: ctx.location_id, account_id: ctx.account_id };
    const fmt = async (v) =>
    {
        if (v === null || v === undefined) { return ""; }
        return display.format(sensor, Number(v), location);
    };
    let returnValue = null;
    if (ctx.cleared_epoch && chosen.template.includes("{return_value}"))
    {
        const ev = await knex(T("alarm_events")).where({ alarm_id: ctx.id, event_kind: "cleared" }).orderBy("epoch", "desc").first();
        returnValue = ev ? ev.value : null;
    }
    const formatted =
    {
        site_name: settings.siteName(),
        alarm_limit: rule && rule.rule_kind === "threshold" ? await fmt(rule.threshold) : "",
        exceed_value: await fmt(ctx.trigger_value),
        return_value: await fmt(returnValue)
    };
    return render(chosen.template, tokens(ctx, rule, formatted));
}

// What a level gets when its own title is blank: { source, template, sourceText }, for the form
// placeholder and help. level is one of CHAIN. known carries what the page has: sensor and
// device templates from their rows, and location_id / account_id (read here through the cache),
// or the location and account templates themselves.
async function inherited(level, known)
{
    const settings = require("../../config/settings");
    const display = require("../display");
    const k = known || {};
    const tpl = { sensor: k.sensor, device: k.device, location: k.location, account: k.account, site: settings.get("ALARM_TITLE_FORMAT", "") };
    if (tpl.location === undefined && k.location_id)
    {
        tpl.location = (await display.scoped("location_settings", "location_id", k.location_id)).ALARM_TITLE_FORMAT;
    }
    if (tpl.account === undefined && k.account_id)
    {
        tpl.account = (await display.scoped("account_settings", "account_id", k.account_id)).ALARM_TITLE_FORMAT;
    }
    const below = CHAIN.slice(CHAIN.indexOf(level) + 1).map((s) => ({ source: s, template: tpl[s] }));
    const p = pick(below);
    return { source: p.source, template: p.template, sourceText: SOURCE_TEXT[p.source] };
}

// Everything views/partials/alarm-title-field.ejs needs. opts: { name, id, value, inherited,
// sample, disabled, size, label }. label false hides the label (the Admin settings table). inherited comes from inherited(); sample overrides SAMPLE with the
// page's real names; size "sm" for the compact rule form.
function field(opts)
{
    const settings = require("../../config/settings");
    return {
        name: opts.name || "alarm_title",
        id: opts.id || "alarm_title",
        value: opts.value || "",
        inherited: opts.inherited,
        tokens: TOKENS.map((n) => ({ name: n, help: TOKEN_HELP[n] })),
        // Undefined page values keep the SAMPLE value, so the preview never shows a known token as unknown.
        sample: Object.assign({ site_name: settings.siteName() }, SAMPLE, Object.fromEntries(Object.entries(opts.sample || {}).filter((e) => e[1] !== undefined && e[1] !== null))),
        disabled: !!opts.disabled,
        size: opts.size || "",
        label: opts.label === false ? "" : (opts.label || "Alarm title")
    };
}

module.exports = { FALLBACK, TOKENS, TOKEN_HELP, SOURCE_TEXT, pick, render, duration, tokens, clean, forAlarm, inherited, field };
