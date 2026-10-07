// public/js/iot-sensor-chart.js: the sensor chart drawing shared by the sensor page and the alarm
// email image. A change here shows on both, so these pin what the sensor page draws today.
const test = require("node:test");
const assert = require("node:assert");
const sc = require("../public/js/iot-sensor-chart.js");

const colors = { primary: "#53b036", danger: "#e05252", warning: "#e5a93d", info: "#42b8c7", text: "#e4e8eb", textMuted: "#89939c", border: "#2a3239", panel: "#171c21" };

test("theme colors read the --iot variables", () =>
{
    const vars = { "--iot-primary": "#1", "--iot-danger": "#2", "--iot-warning": "#3", "--iot-info": "#4", "--iot-text": "#5", "--iot-text-muted": "#6", "--iot-border": "#7", "--iot-panel": "#8" };
    assert.deepStrictEqual(sc.themeColors((n) => vars[n]), { primary: "#1", danger: "#2", warning: "#3", info: "#4", text: "#5", textMuted: "#6", border: "#7", panel: "#8" });
});

test("severity colors, unknown falls back to danger", () =>
{
    assert.equal(sc.sevColor(colors, "info"), colors.info);
    assert.equal(sc.sevColor(colors, "warning"), colors.warning);
    assert.equal(sc.sevColor(colors, "alarm"), colors.danger);
    assert.equal(sc.sevColor(colors, "emergency"), colors.danger);
    assert.equal(sc.sevColor(colors, "other"), colors.danger);
});

test("bands stack like a ladder on each side", () =>
{
    const rules = [{ direction: "upper", severity: "alarm", value: 40 }, { direction: "upper", severity: "warning", value: 30 }, { direction: "lower", severity: "info", value: 5 }];
    const b = sc.bands(rules, colors);
    assert.equal(b.length, 3);
    assert.deepStrictEqual(b[0], [{ yAxis: 30, itemStyle: { color: colors.warning, opacity: 0.10 } }, { yAxis: 40 }]);
    assert.deepStrictEqual(b[1], [{ yAxis: 40, itemStyle: { color: colors.danger, opacity: 0.12 } }, { yAxis: 1e9 }]);
    assert.deepStrictEqual(b[2], [{ yAxis: 5, itemStyle: { color: colors.info, opacity: 0.08 } }, { yAxis: -1e9 }]);
});

test("nice bounds land on tick steps", () =>
{
    assert.deepStrictEqual(sc.niceBounds(0.3, 9.7), [0, 10]);
    assert.deepStrictEqual(sc.niceBounds(20, 51.5), [20, 60]);
});

test("y bounds keep thresholds in view unless fit to data", () =>
{
    const rules = [{ direction: "upper", severity: "alarm", value: 50 }];
    const yb = sc.yBounds(rules, false);
    assert.deepStrictEqual([yb.min({ min: 20, max: 30 }), yb.max({ min: 20, max: 30 })], [20, 60]);
    assert.deepStrictEqual(sc.yBounds(rules, true), { min: null, max: null });
    assert.deepStrictEqual(sc.yBounds([], false), { min: null, max: null });
});

test("threshold lines carry the severity, value and unit", () =>
{
    const m = sc.thresholdMarks([{ direction: "lower", severity: "warning", value: 4.25 }], colors, 1, "C");
    assert.deepStrictEqual(m, [{ yAxis: 4.25, lineStyle: { color: colors.warning, type: "dashed" }, label: { position: "insideEndBottom", color: colors.warning, formatter: "Warning 4.3 C" } }]);
});

test("option pins the x axis and carries bands, lines and zoom", () =>
{
    const d = { from: 1000, to: 2000, unit: "C", points: [[1000, 1], [2000, 2]], rules: [{ direction: "upper", severity: "alarm", value: 3 }] };
    const o = sc.option(d, { colors: colors, precision: 2, fit: false, zoom: { start: 10, end: 90 } });
    assert.equal(o.xAxis.min, 1000);
    assert.equal(o.xAxis.max, 2000);
    assert.equal(o.series[0].markArea.data.length, 1);
    assert.equal(o.series[0].markLine.data.length, 1);
    assert.equal(o.dataZoom[1].start, 10);
    assert.equal(o.tooltip.valueFormatter(1.5), "1.50 C");
});

// Alarm markers (Jeff, Oct 2026): raise and escalate point right in the new severity's color;
// lowering points left in the color of the level left; clear points left in the severity cleared from.
function ev(uid, epoch, kind, severity) { return { uid: uid, epoch: epoch, event_kind: kind, severity: severity }; }

test("markers: warning, escalated to alarm, both cleared together", () =>
{
    const m = sc.alarmMarkers([ev("a", 100, "raised", "warning"), ev("a", 200, "escalated", "alarm"), ev("a", 300, "cleared", "alarm")], 0, 1e9);
    assert.deepStrictEqual(m.map((x) => [x.t, x.up, x.severity]), [[100000, true, "warning"], [200000, true, "alarm"], [300000, false, "alarm"]]);
});

test("markers: lowering takes the color of the level it left", () =>
{
    const m = sc.alarmMarkers([ev("b", 100, "raised", "warning"), ev("b", 200, "escalated", "alarm"), ev("b", 300, "de_escalated", "warning"), ev("b", 400, "cleared", "warning")], 0, 1e9);
    assert.deepStrictEqual(m.map((x) => [x.kind, x.up, x.severity]), [["raised", true, "warning"], ["escalated", true, "alarm"], ["de_escalated", false, "alarm"], ["cleared", false, "warning"]]);
    assert.equal(sc.markerText(m[2]), "Lowered from alarm to warning");
});

test("markers: only inside the window, earlier events still set the level", () =>
{
    const m = sc.alarmMarkers([ev("c", 100, "raised", "warning"), ev("c", 200, "escalated", "alarm"), ev("c", 300, "de_escalated", "warning")], 250000, 1e9);
    assert.equal(m.length, 1);
    assert.equal(m[0].severity, "alarm");
});

test("markers: a suppressed alarm draws nothing until suppression lifts", () =>
{
    const m = sc.alarmMarkers([ev("d", 100, "suppressed", "alarm"), ev("d", 150, "cleared", "alarm"), ev("e", 100, "suppressed", "alarm"), ev("e", 200, "raised", "alarm"), ev("e", 300, "cleared", "alarm")], 0, 1e9);
    assert.deepStrictEqual(m.map((x) => [x.uid, x.kind]), [["e", "raised"], ["e", "cleared"]]);
});

test("option adds a hoverable alarm series only when there are markers", () =>
{
    const d = { from: 0, to: 1000000, unit: "C", points: [], rules: [], alarms: [] };
    const o = { colors: colors, precision: 1, fit: false, zoom: { start: 0, end: 100 } };
    assert.equal(sc.option(d, o).series.length, 1);
    d.alarms = [ev("a", 100, "raised", "warning")];
    const opt = sc.option(d, o);
    assert.equal(opt.series.length, 2);
    const pair = opt.series[1].markLine.data[0];
    assert.equal(pair[1].symbol, "triangle");
    assert.equal(pair[1].symbolRotate, -90);
    assert.equal(pair[0].lineStyle.color, colors.warning);
});
