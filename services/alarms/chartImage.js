// Chart image in alarm emails (DECISIONS.md "Chart image in alarm emails"). The sensor chart drawn on
// the server as a PNG: the same threshold bands, threshold lines, y axis rule and alarm markers as the
// sensor page, because both use public/js/iot-sensor-chart.js, on the site's dark panel with the
// colors read from public/css/iot-theme.css. ECharts draws an SVG string (server side rendering,
// echarts.init(null, null, { renderer: "svg", ssr: true }), 5.3 and later) and resvg turns it into a
// PNG with the Inter font shipped in assets/fonts, since the server may have no fonts at all.
// Threshold rules only, and only when the rule's chart_in_alarm is on. A failure here must never stop
// an alarm going out: forAlarm() logs and answers null, and the email goes without the image.
// The logger and database modules load inside forAlarm(), so the pure parts test without them.
const fs = require("fs");
const path = require("path");
const metrics = require("../../metrics");
const sensorChart = require("../../public/js/iot-sensor-chart");

const DAY = 86400;
const MAX_SPAN = 366 * DAY;            // a chart window is at most a year (routes/sensors.js CHART_MAX_SPAN)
const AUTO_MIN = 30 * DAY;             // Auto: twice exceed_secs, at least 30 days (Jeff, Oct 2026)
const RAISE_MARGIN = 0.05;             // a clear image keeps the raise this far in from the left edge
const MAX_READINGS = 100000;           // newest kept, the charts' ceiling
const WIDTH = 1000;
const HEIGHT = 440;
const HEAD = 56;                       // title and window lines above the plot, as the Share PNG
const SCALE = 2;                       // drawn at twice the size, as the Share PNG
const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");
const FONT_FILES = [path.join(FONT_DIR, "Inter-Regular.ttf"), path.join(FONT_DIR, "Inter-SemiBold.ttf")];

// --iot-* variables from the first :root block of the theme, read once.
let themeVars = null;
function colors()
{
    if (!themeVars)
    {
        themeVars = {};
        const css = fs.readFileSync(path.join(__dirname, "..", "..", "public", "css", "iot-theme.css"), "utf8");
        const root = (css.match(/:root\s*\{([^}]*)\}/) || [])[1] || "";
        root.replace(/(--iot-[a-z0-9-]+)\s*:\s*([^;]+);/gi, (m, k, v) => { themeVars[k] = v.replace(/\/\*.*?\*\//g, "").trim(); return m; });
    }
    return sensorChart.themeColors((name) => themeVars[name] || "");
}

// The window in epoch seconds. Its length is the rule's chart_window_secs, else Auto; never more than
// a year. It ends at the event. A clear image stretches back so the raise is in view, RAISE_MARGIN of
// the window in from the left, unless that would pass a year; then it is the year before the clear.
function windowFor(rule, raisedEpoch, endEpoch, includeRaise)
{
    let span = rule.chart_window_secs ? Number(rule.chart_window_secs) : Math.max(2 * Number(rule.exceed_secs || 0), AUTO_MIN);
    span = Math.min(span, MAX_SPAN);
    if (includeRaise && raisedEpoch < endEpoch)
    {
        const need = Math.ceil((endEpoch - raisedEpoch) / (1 - RAISE_MARGIN));
        if (need > span) { span = Math.min(need, MAX_SPAN); }
    }
    return { from: endEpoch - span, to: endEpoch };
}

// The alarm page chart (DECISIONS "Alarm page chart"), from the same rules: once cleared, the clear
// email's window; while active, the raised email's window before the raise and on up to now, live
// (to is null), never more than a year. Epoch seconds.
function pageWindowFor(rule, raisedEpoch, clearedEpoch, now)
{
    if (clearedEpoch) { return windowFor(rule, raisedEpoch, clearedEpoch, true); }
    const w = windowFor(rule, raisedEpoch, raisedEpoch, false);
    return { from: Math.max(w.from, now - MAX_SPAN), to: null };
}

// ECharts formats a time axis in the process's own timezone, or in UTC with useUTC. To label the axis
// in the location's timezone, every time is moved by that zone's offset at that moment and the chart
// is drawn in UTC. Offsets are cached per hour, so a year of readings costs about 8800 lookups.
function shifter(tz)
{
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const cache = new Map();
    function offset(ms)
    {
        const hour = Math.floor(ms / 3600000);
        if (cache.has(hour)) { return cache.get(hour); }
        const p = {};
        f.formatToParts(new Date(hour * 3600000)).forEach((x) => { p[x.type] = x.value; });
        const off = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - hour * 3600000;
        cache.set(hour, off);
        return off;
    }
    return (ms) => ms + offset(ms);
}

// "2026-10-06 21:55" in tz, the Share PNG's window format without seconds.
function localMinute(epoch, tz)
{
    return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(epoch * 1000));
}

// Pure drawing, no database: d as the sensor page's /data answer (times in ms, values in display
// units, alarms as marker events with epoch seconds), meta: { title, tz, precision }. Answers a PNG.
function render(d, meta)
{
    const echarts = require("echarts");
    const { Resvg } = require("@resvg/resvg-js");
    const c = colors();
    const shift = shifter(meta.tz);
    const shifted =
    {
        from: shift(d.from), to: shift(d.to), unit: d.unit, rules: d.rules,
        points: d.points.map((p) => [shift(p[0]), p[1]]),
        alarms: (d.alarms || []).map((e) => Object.assign({}, e, { epoch: shift(Number(e.epoch) * 1000) / 1000 }))
    };
    const opt = sensorChart.option(shifted, { colors: c, precision: meta.precision, fit: false, zoom: null });
    opt.useUTC = true;
    opt.backgroundColor = c.panel;
    opt.textStyle = { fontFamily: "Inter" };
    opt.grid.top = HEAD + 24;
    opt.title =
    [
        { text: meta.title, left: 16, top: 12, textStyle: { color: c.text, fontSize: 16, fontWeight: 600, fontFamily: "Inter" } },
        { text: localMinute(d.from / 1000, meta.tz) + " to " + localMinute(d.to / 1000, meta.tz) + " (" + meta.tz + ")", left: 16, top: 36, textStyle: { color: c.textMuted, fontSize: 12, fontWeight: 400, fontFamily: "Inter" } }
    ];
    // The markers' hover labels have no use in a still image.
    opt.series.forEach((s) => { if (s.markLine && s.name === "Alarms") { s.markLine.silent = true; } });
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: WIDTH, height: HEIGHT });
    let svg;
    try
    {
        chart.setOption(opt);
        svg = chart.renderToSVGString();
    }
    finally
    {
        // Without dispose the chart's animation timer keeps running and the process never lets go
        // of it (seen in 6.1.0 even with animation: false).
        chart.dispose();
    }
    const resvg = new Resvg(svg, { fitTo: { mode: "zoom", value: SCALE }, font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: "Inter" } });
    return resvg.render().asPng();
}

// ctx: alarmsRepo.context(); rule: the alarm's rule row; eventKind: raised or cleared; endEpoch: when
// the event happened; title: the alarm title. Answers { data (PNG Buffer), filename, from, to } or null.
async function forAlarm(ctx, rule, eventKind, endEpoch, title)
{
    if (!rule || rule.rule_kind !== "threshold" || !rule.chart_in_alarm) { return null; }
    if (eventKind !== "raised" && eventKind !== "cleared") { return null; }
    const logger = require("../../config/logger");
    try
    {
        const { knex, T } = require("../../db/knex");
        const display = require("../display");
        const sensorsExt = require("../../db/repos/sensorsExt");
        const alarmsRepo = require("../../db/repos/alarms");
        const tz = ctx.iana_timezone || "UTC";
        const w = windowFor(rule, Number(ctx.raised_epoch), endEpoch, eventKind === "cleared");
        const unit = await display.resolveUnit({ metric: ctx.metric, display_unit: ctx.display_unit }, { id: ctx.location_id, account_id: ctx.account_id });
        const toDisplay = (v) => metrics.fromCanonical(ctx.metric, Number(v), unit);
        const precision = ctx.display_precision !== null && ctx.display_precision !== undefined ? Number(ctx.display_precision) : metrics.precision(ctx.metric, unit);
        const readings = await sensorsExt.readings(ctx.sensor_id, w.from, w.to, MAX_READINGS);
        const rules = await knex(T("alarm_rules")).where({ sensor_id: ctx.sensor_id, rule_kind: "threshold", is_enabled: 1 }).whereNull("delete_epoch");
        const d =
        {
            from: w.from * 1000, to: w.to * 1000, unit: unit,
            points: readings.map((r) => [Number(r.epoch) * 1000, Number(toDisplay(r.value).toFixed(4))]),
            rules: rules.map((r) => ({ direction: r.direction, severity: r.severity, value: toDisplay(r.threshold) })),
            alarms: (await alarmsRepo.markerEvents(ctx.sensor_id, w.from, w.to)).map((e) => ({ uid: String(e.uid).toLowerCase(), epoch: Number(e.epoch), event_kind: e.event_kind, severity: e.severity }))
        };
        const started = Date.now();
        const png = render(d, { title: title, tz: tz, precision: precision });
        logger.info({ alarm: ctx.id, event: eventKind, readings: d.points.length, bytes: png.length, ms: Date.now() - started }, "alarm chart drawn");
        return { data: png, filename: "alarm-chart-" + localMinute(endEpoch, tz).replace(/[ :]/g, "-") + ".png", from: w.from, to: w.to };
    }
    catch (err)
    {
        logger.warn({ alarm: ctx.id, event: eventKind, err: err.message }, "alarm chart failed, sending without it");
        return null;
    }
}

module.exports = { forAlarm, render, windowFor, pageWindowFor, shifter, colors };
