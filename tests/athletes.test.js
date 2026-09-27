// Athletes and wristbands (DECISIONS.md "Athletes and wristbands"): the pure helpers.
const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
const a = require("../services/athletes");

test("athlete ids are made from the name", () =>
{
    assert.equal(a.slugBase("Jordan Smith"), "jordan-smith");
    assert.equal(a.slugBase("  José   Núñez "), "jose-nunez");
    assert.equal(a.slugBase("O'Brien-Smythe, Jr."), "o-brien-smythe-jr");
    assert.equal(a.slugBase("!!!"), "athlete");
    assert.ok(a.slugBase("x".repeat(100)).length <= 50);
});

test("names and band ids are cleaned", () =>
{
    assert.equal(a.cleanName("  Jordan   Smith "), "Jordan Smith");
    assert.equal(a.cleanName("   "), null);
    assert.equal(a.cleanName("x".repeat(81)), null);
    assert.equal(a.normalizeBand("c0:ff:ee:12:34:56"), "C0FFEE123456");
    assert.equal(a.normalizeBand("C0FFEE12345"), null);
});

test("loaner lengths", () =>
{
    assert.equal(a.LOANS.permanent, null);
    assert.equal(a.LOANS["12h"], 43200);
    assert.deepEqual(Object.keys(a.LOANS), Object.keys(a.LOAN_LABELS));
});
