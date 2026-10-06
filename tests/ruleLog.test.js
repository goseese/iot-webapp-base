const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";
const ruleLog = require("../services/alarms/ruleLog");

const ROW = { rule_kind: "threshold", direction: "upper", threshold: 80, severity: "alarm", exceed_secs: 300, return_secs: 300, timeout_secs: null, is_enabled: true, use_default_group: true, channel_policy: null, alarm_title: null };

test("snapshotOf: text values, booleans as 1 and 0, NULL policy as the form writes it, groups sorted", () =>
{
    const s = ruleLog.snapshotOf(ROW, ["Night crew", "Day crew"]);
    assert.equal(s.threshold, "80");
    assert.equal(s.timeout_secs, null);
    assert.equal(s.is_enabled, "1");
    assert.equal(s.channel_policy, ruleLog.NULL_POLICY);
    assert.equal(s.alert_groups, "Day crew, Night crew");
    assert.equal(ruleLog.snapshotOf(ROW, []).alert_groups, null);
});

test("NULL_POLICY is the text the rule form writes for an untouched rule", () =>
{
    const policy = {};
    for (const tr of ["raise", "escalate", "de_escalate", "clear"]) { policy[tr] = { email: true, sms: false }; }
    assert.equal(JSON.stringify(policy), ruleLog.NULL_POLICY);
});

test("diff: only changed fields, booleans from different sources compare alike", () =>
{
    const before = ruleLog.snapshotOf(ROW, []);
    const after = ruleLog.snapshotOf(Object.assign({}, ROW, { is_enabled: 1, threshold: 85, alarm_title: "X {sensor_name}" }), []);
    assert.deepEqual(ruleLog.diff(before, after),
    [
        { field: "threshold", oldValue: "80", newValue: "85" },
        { field: "alarm_title", oldValue: null, newValue: "X {sensor_name}" }
    ]);
    assert.deepEqual(ruleLog.diff(before, ruleLog.snapshotOf(Object.assign({}, ROW, { channel_policy: ruleLog.NULL_POLICY }), [])), []);
});
