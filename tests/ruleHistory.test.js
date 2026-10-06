const test = require("node:test");
const assert = require("node:assert");
const h = require("../services/alarms/ruleHistory");
const ruleLog = require("../services/alarms/ruleLog");

const fmt = { threshold: (v) => (Number(v) * 9 / 5 + 32).toFixed(1) + " F" };
const ROW = { rule_kind: "threshold", direction: "upper", threshold: 8, severity: "alarm", exceed_secs: 300, return_secs: 300, timeout_secs: null, is_enabled: true, use_default_group: true, channel_policy: null, alarm_title: null };

test("who", () =>
{
    assert.equal(h.who({ actor_type: "system" }), "System");
    assert.equal(h.who({ actor_type: "api_credential", actor_name: "ops" }), "API key ops");
    assert.equal(h.who({ actor_type: "user", actor_name: "jseese" }), "jseese");
});

test("created row: whole rule in one line with reason", () =>
{
    const json = JSON.stringify(Object.assign(ruleLog.snapshotOf(ROW, ["Night crew"]), { reason: "device type default" }));
    const l = h.line({ epoch: "100", field: "created", new_value: json, actor_type: "system" }, fmt);
    assert.equal(l.what, "Created");
    assert.equal(l.after, "Above 46.4 F, alarm, exceed 5 min, return 5 min, groups: Night crew (device type default)");
});

test("deleted no data rule", () =>
{
    const json = JSON.stringify(ruleLog.snapshotOf({ rule_kind: "no_data", severity: "warning", timeout_secs: 1800, exceed_secs: 0, return_secs: 0, is_enabled: false, use_default_group: true }, []));
    const l = h.line({ epoch: 1, field: "deleted", old_value: json, actor_type: "user", actor_name: "jseese" }, fmt);
    assert.equal(l.before, "No data 30 min, warning, disabled");
});

test("field changes are labelled and formatted", () =>
{
    assert.deepEqual(h.line({ epoch: 1, field: "threshold", old_value: "8", new_value: "10", actor_type: "user", actor_name: "a" }, fmt).after, "50.0 F");
    assert.equal(h.line({ epoch: 1, field: "exceed_secs", old_value: "300", new_value: "600", actor_type: "user" }, fmt).what, "Exceed delay");
    assert.equal(h.value("is_enabled", "0"), "off");
    assert.equal(h.value("alert_groups", null), "none");
    assert.equal(h.value("alarm_title", null), "--");
    assert.equal(h.value("channel_policy", ruleLog.NULL_POLICY), "Raise email, Escalate email, De-escalate email, Clear email");
    assert.equal(h.value("channel_policy", JSON.stringify({ raise: { email: true, sms: true }, escalate: { email: false, sms: false } })), "Raise email+SMS, Escalate off, De-escalate email+SMS, Clear email+SMS");
});
