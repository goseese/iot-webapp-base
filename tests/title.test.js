const test = require("node:test");
const assert = require("node:assert");
const title = require("../services/alarms/title");

test("pick: most specific non blank wins", () =>
{
    const r = title.pick([{ source: "rule", template: null }, { source: "sensor", template: "S {sensor_name}" }, { source: "device", template: "D" }]);
    assert.deepEqual(r, { source: "sensor", template: "S {sensor_name}" });
});

test("pick: white space only counts as blank, all blank gives the default", () =>
{
    const r = title.pick([{ source: "rule", template: "   " }, { source: "sensor", template: "" }, { source: "site", template: undefined }]);
    assert.deepEqual(r, { source: "default", template: title.FALLBACK });
});

test("render: tokens fill, unknown stay, missing values blank, one line", () =>
{
    assert.equal(title.render("{sensor_name} on {device_name}", { sensor_name: "Temp", device_name: "Server" }), "Temp on Server");
    assert.equal(title.render("{senser_name} x", { sensor_name: "Temp" }), "{senser_name} x");
    assert.equal(title.render("A {exceed_value} B", { exceed_value: null }), "A B");
    assert.equal(title.render("  line one\r\n  line two \n", {}), "line one line two");
});

test("duration: words, largest units first", () =>
{
    assert.equal(title.duration(0), "0 seconds");
    assert.equal(title.duration(45), "45 seconds");
    assert.equal(title.duration(60), "1 minute");
    assert.equal(title.duration(1800), "30 minutes");
    assert.equal(title.duration(5400), "1 hour 30 minutes");
    assert.equal(title.duration(90061), "1 day 1 hour 1 minute 1 second");
    assert.equal(title.duration(null), "");
    assert.equal(title.duration(""), "");
});

test("clean: one line, trimmed, 200 characters, blank is null", () =>
{
    assert.equal(title.clean("  a \n b  "), "a b");
    assert.equal(title.clean("x".repeat(250)).length, 200);
    assert.equal(title.clean("   "), null);
    assert.equal(title.clean(null), null);
});

const CTX = { account_name: "Acme", location_name: "Main", device_name: "Server", sensor_name: "CPU temp", severity: "alarm", direction: "upper" };

test("tokens: threshold alarm", () =>
{
    const rule = { rule_kind: "threshold", exceed_secs: 300, return_secs: 600, timeout_secs: null };
    const v = title.tokens(CTX, rule, { site_name: "Example", alarm_limit: "80.0 C", exceed_value: "82.5 C", return_value: "" });
    assert.equal(v.direction, "above");
    assert.equal(v.alarm_limit, "80.0 C");
    assert.equal(v.exceed_value, "82.5 C");
    assert.equal(v.exceed_duration, "5 minutes");
    assert.equal(v.return_duration, "10 minutes");
    assert.equal(v.site_name, "Example");
});

test("tokens: no data alarm", () =>
{
    const rule = { rule_kind: "no_data", exceed_secs: 0, return_secs: 0, timeout_secs: 1800 };
    const v = title.tokens(Object.assign({}, CTX, { direction: "no_data" }), rule, { alarm_limit: "ignored", exceed_value: "1", return_value: "2" });
    assert.equal(v.direction, "no data");
    assert.equal(v.alarm_limit, "no data");
    assert.equal(v.exceed_value, "");
    assert.equal(v.return_value, "");
    assert.equal(v.exceed_duration, "30 minutes");
    assert.equal(v.return_duration, "");
});

test("tokens: no rule leaves both durations blank", () =>
{
    const v = title.tokens(Object.assign({}, CTX, { direction: "lower" }), null, {});
    assert.equal(v.direction, "below");
    assert.equal(v.exceed_duration, "");
    assert.equal(v.return_duration, "");
});
