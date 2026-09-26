// Guards against require cycles leaving a module half loaded.
const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";

test("pipeline modules load with complete exports", () =>
{
    const identify = require("../pipeline/identify");
    const provisioning = require("../services/provisioning");
    const client = require("../mqtt/client");
    assert.equal(typeof identify.handle, "function");
    assert.equal(typeof provisioning.handleRequest, "function");
    assert.equal(typeof client.get, "function");
    assert.equal(typeof require("../jobs/tasks/serverStats").run, "function");
    assert.equal(typeof require("../services/broker").active().createDeviceUser, "function");
});
