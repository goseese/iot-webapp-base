const test = require("node:test");
const assert = require("node:assert");
const p = require("../permissions");

test("bits are unique powers of two", () =>
{
    const seen = new Set();
    for (const b of p.BITS)
    {
        assert.equal(b.bit & (b.bit - 1n), 0n);
        assert.ok(!seen.has(b.bit));
        seen.add(b.bit);
    }
});

test("union of account and location grants, check is subset", () =>
{
    const account = p.bitsOf(["view"]);
    const location = p.bitsOf(["edit", "ack_alarm"]);
    const effective = account | location;
    assert.ok(p.has(effective, p.bitsOf(["view", "edit"])));
    assert.ok(!p.has(effective, p.bitsOf(["delete"])));
    assert.deepEqual(p.names(effective), ["view", "edit", "ack_alarm"]);
});
