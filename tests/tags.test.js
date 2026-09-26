const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";
const tags = require("../services/tags");

test("tag query any/all/none/text", () =>
{
    const t = ["dashboard", "freezer"];
    assert.ok(tags.matches({ any: ["freezer", "x"] }, t));
    assert.ok(!tags.matches({ all: ["freezer", "x"] }, t));
    assert.ok(!tags.matches({ none: ["dashboard"] }, t));
    assert.ok(tags.matches({ text: "Free" }, t, "Freezer 2"));
    assert.ok(!tags.matches({ text: "lab" }, t, "Freezer 2"));
    assert.ok(tags.matches(null, t));
});

test("sensor tags: own always apply, device tags unless excluded", () =>
{
    assert.deepEqual(tags.combine(["freezer"], ["dashboard", "dailyReport"], []), ["freezer", "dashboard", "dailyReport"]);
    assert.deepEqual(tags.combine([], ["dashboard", "dailyReport"], ["dashboard"]), ["dailyReport"]);
    assert.deepEqual(tags.combine(["dashboard"], ["dashboard"], ["dashboard"]), ["dashboard"]);
    assert.deepEqual(tags.combine(null, null, null), []);
});
