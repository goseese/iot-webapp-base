const test = require("node:test");
const assert = require("node:assert");
const { normalize, validate } = require("../services/configValues");

test("normalize matches what the gateway echoes back", () =>
{
    assert.equal(normalize({ kind: "hexlist" }, "21, 22"), "21,22");
    assert.equal(normalize({ kind: "hexlist" }, "0A,FF"), "a,ff");
    assert.equal(normalize({ kind: "float", decimals: 1 }, "915"), "915.0");
    assert.equal(normalize({ kind: "bool" }, "YES"), "true");
    assert.equal(normalize({ kind: "bool" }, "0"), "false");
    assert.equal(normalize({ kind: "int" }, " 010 "), "10");
    assert.equal(normalize(null, " hologram "), "hologram");
});

test("validate rejects bad input and returns the value to send", () =>
{
    assert.deepEqual(validate({ kind: "int", min: 1, max: 65535 }, "8883"), { ok: true, value: "8883" });
    assert.equal(validate({ kind: "int", min: 1 }, "0").ok, false);
    assert.equal(validate({ kind: "int" }, "ten").ok, false);
    assert.deepEqual(validate({ kind: "hexlist" }, "21, 22"), { ok: true, value: "21,22" });
    assert.equal(validate({ kind: "hexlist" }, "21,zz").ok, false);
    assert.equal(validate({ kind: "bool" }, "maybe").ok, false);
    assert.equal(validate({ kind: "string" }, "x".repeat(100)).ok, false);
});

test("validate enforces the key's maxLength", () =>
{
    assert.equal(validate({ kind: "string", maxLength: 15 }, "x".repeat(15)).ok, true);
    assert.equal(validate({ kind: "string", maxLength: 15 }, "x".repeat(16)).ok, false);
});
