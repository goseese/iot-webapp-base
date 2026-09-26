const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";
const passwords = require("../services/passwords");

test("default policy: 10 chars, upper, lower, digit", () =>
{
    assert.ok(passwords.check("short") !== null);
    assert.ok(passwords.check("alllowercase1x") !== null);
    assert.equal(passwords.check("GoodPassword1"), null);
});

test("hash verifies and rejects", async () =>
{
    const h = await passwords.hash("GoodPassword1");
    assert.ok(await passwords.verify("GoodPassword1", h));
    assert.ok(!(await passwords.verify("wrong", h)));
    assert.ok(!(await passwords.verify("x", null)));
});
