const test = require("node:test");
const assert = require("node:assert");
const m = require("../metrics");

test("temperature converts with offset", () =>
{
    assert.equal(m.toCanonical("temperature", 212, "F"), 100);
    assert.equal(m.fromCanonical("temperature", 0, "F"), 32);
});

test("temperature_delta converts without offset", () =>
{
    assert.equal(m.toCanonical("temperature_delta", 18, "F"), 10);
    assert.equal(m.fromCanonical("temperature_delta", 10, "F"), 18);
});

test("duration ms to seconds and precision per unit", () =>
{
    assert.equal(m.toCanonical("duration", 250, "ms"), 0.25);
    assert.equal(m.precision("duration", "ms"), 0);
    assert.equal(m.precision("duration", "s"), 3);
});

test("unknown unit is rejected", () =>
{
    assert.throws(() => m.toCanonical("humidity", 1, "F"));
});
