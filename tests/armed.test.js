const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";
const armed = require("../services/alarms/armed");

// 2024-01-10 is a Wednesday. 15:00 UTC = 09:00 America/Chicago.
const WED_1500_UTC = Date.UTC(2024, 0, 10, 15, 0, 0) / 1000;

test("local dow and minute in location timezone", () =>
{
    const r = armed.localDowMinute(WED_1500_UTC, "America/Chicago");
    assert.equal(r.dow, 3);
    assert.equal(r.minute, 9 * 60);
});

test("window inside the day", () =>
{
    const s = { dow_mask: 1 << 3, start_minute: 8 * 60, end_minute: 10 * 60 };
    assert.ok(armed.windowActive(s, WED_1500_UTC, "America/Chicago"));
    assert.ok(!armed.windowActive({ dow_mask: 1 << 3, start_minute: 10 * 60, end_minute: 12 * 60 }, WED_1500_UTC, "America/Chicago"));
});

test("window crossing midnight uses yesterday's mask for the early part", () =>
{
    const s = { dow_mask: 1 << 2, start_minute: 22 * 60, end_minute: 10 * 60 };   // Tue 22:00 -> Wed 10:00
    assert.ok(armed.windowActive(s, WED_1500_UTC, "America/Chicago"));                 // Wed 09:00 is the tail
    assert.ok(!armed.windowActive({ dow_mask: 1 << 3, start_minute: 22 * 60, end_minute: 10 * 60 }, WED_1500_UTC, "America/Chicago"));
});
