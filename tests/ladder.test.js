const test = require("node:test");
const assert = require("node:assert");
const ladder = require("../services/alarms/ladder");

function rules()
{
    return [
        { id: 1, direction: "upper", threshold: 30, severity: "warning", exceed_secs: 60, return_secs: 60, breach_since: null, return_since: null },
        { id: 2, direction: "upper", threshold: 40, severity: "alarm", exceed_secs: 120, return_secs: 60, breach_since: null, return_since: null }
    ];
}

test("raise waits for exceed duration", () =>
{
    const r = rules();
    assert.equal(ladder.evaluate(r, null, 35, 1000).transition, null);
    assert.equal(ladder.evaluate(r, null, 35, 1030).transition, null);
    const t = ladder.evaluate(r, null, 35, 1060);
    assert.equal(t.transition, "raise");
    assert.equal(t.severity, "warning");
});

// The walk from the design: warning active, value crosses the alarm threshold, alarm rule's
// own exceed runs, then escalate in place; drop back below both, clear after return.
test("escalate during warning, then de-escalate and clear", () =>
{
    const r = rules();
    ladder.evaluate(r, null, 35, 0);
    assert.equal(ladder.evaluate(r, null, 35, 60).transition, "raise");
    const active = { severity: "warning" };
    assert.equal(ladder.evaluate(r, active, 45, 100).transition, null);       // alarm rule clock starts at 100
    assert.equal(ladder.evaluate(r, active, 45, 200).transition, null);
    const e = ladder.evaluate(r, active, 45, 220);
    assert.equal(e.transition, "escalate");
    assert.equal(e.severity, "alarm");
    active.severity = "alarm";
    assert.equal(ladder.evaluate(r, active, 35, 300).transition, null);       // alarm rule in return window
    const d = ladder.evaluate(r, active, 35, 360);
    assert.equal(d.transition, "de_escalate");
    assert.equal(d.severity, "warning");
    active.severity = "warning";
    assert.equal(ladder.evaluate(r, active, 20, 400).transition, null);
    assert.equal(ladder.evaluate(r, active, 20, 460).transition, "clear");
});

test("brief return inside the window does not clear", () =>
{
    const r = rules();
    ladder.evaluate(r, null, 35, 0);
    ladder.evaluate(r, null, 35, 60);
    const active = { severity: "warning" };
    assert.equal(ladder.evaluate(r, active, 25, 100).transition, null);
    assert.equal(ladder.evaluate(r, active, 35, 130).transition, null);
    assert.equal(r[0].return_since, null);                                    // breach again resets return clock
});

test("manual clear zeroes clocks, re-raise needs full exceed", () =>
{
    const r = rules();
    ladder.evaluate(r, null, 35, 0);
    ladder.evaluate(r, null, 35, 60);
    ladder.zeroClocks(r);
    assert.equal(ladder.evaluate(r, null, 35, 61).transition, null);
    assert.equal(ladder.evaluate(r, null, 35, 121).transition, "raise");
});

test("lower direction", () =>
{
    const r = [{ id: 3, direction: "lower", threshold: 2, severity: "alarm", exceed_secs: 0, return_secs: 0, breach_since: null, return_since: null }];
    assert.equal(ladder.evaluate(r, null, 1, 10).transition, "raise");
    assert.equal(ladder.evaluate(r, { severity: "alarm" }, 3, 11).transition, "clear");
});
