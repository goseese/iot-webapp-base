// services/alarms/chartImage.js: the alarm email chart window and the timezone shift (pure parts).
const test = require("node:test");
const assert = require("node:assert");
const ci = require("../services/alarms/chartImage");

const DAY = 86400;
const END = 1791341700;   // 2026-10-06 21:55 in Chicago

function days(w) { return (w.to - w.from) / DAY; }

test("Auto is twice exceed, at least 30 days", () =>
{
    assert.equal(days(ci.windowFor({ exceed_secs: 600 }, END, END, false)), 30);
    assert.equal(days(ci.windowFor({ exceed_secs: 35 * DAY }, END, END, false)), 70);
    assert.equal(ci.windowFor({ exceed_secs: 600 }, END, END, false).to, END);
});

test("a chosen window wins, and nothing passes a year", () =>
{
    assert.equal(days(ci.windowFor({ exceed_secs: 600, chart_window_secs: 7 * DAY }, END, END, false)), 7);
    assert.equal(days(ci.windowFor({ exceed_secs: 400 * DAY }, END, END, false)), 366);
});

test("a clear image keeps the raise in view, 5% in from the left", () =>
{
    const raised = END - 45 * DAY;
    const w = ci.windowFor({ exceed_secs: 600 }, raised, END, true);
    assert.ok(w.from < raised);
    assert.ok(Math.abs((raised - w.from) / (w.to - w.from) - 0.05) < 0.001);
    // Raise well inside the default window: no stretch.
    assert.equal(days(ci.windowFor({ exceed_secs: 600 }, END - DAY, END, true)), 30);
    // Raise more than a year back: the year before the clear.
    assert.equal(days(ci.windowFor({ exceed_secs: 600 }, END - 730 * DAY, END, true)), 366);
});

test("times shift to the location's wall clock, across daylight saving", () =>
{
    const s = ci.shifter("America/Chicago");
    const oct = Date.UTC(2026, 9, 7, 2, 55);    // 21:55 CDT
    const dec = Date.UTC(2026, 11, 7, 2, 55);   // 20:55 CST
    assert.equal(new Date(s(oct)).toISOString().slice(0, 16), "2026-10-06T21:55");
    assert.equal(new Date(s(dec)).toISOString().slice(0, 16), "2026-12-06T20:55");
    assert.equal(ci.shifter("UTC")(oct), oct);
});

test("theme colors come from iot-theme.css", () =>
{
    const c = ci.colors();
    assert.match(c.panel, /^#[0-9a-f]{6}$/i);
    assert.match(c.danger, /^#[0-9a-f]{6}$/i);
    assert.match(c.primary, /^#[0-9a-f]{6}$/i);
});
