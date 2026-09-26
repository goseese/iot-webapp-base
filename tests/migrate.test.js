const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";
const { splitBatches } = require("../db/migrate");

test("GO splits batches and drops empties", () =>
{
    const parts = splitBatches("CREATE TABLE a (id INT);\nGO\n\nGO\nCREATE INDEX i ON a(id);\ngo\n");
    assert.deepEqual(parts, ["CREATE TABLE a (id INT);", "CREATE INDEX i ON a(id);"]);
});
