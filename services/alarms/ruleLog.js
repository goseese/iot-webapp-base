// Alarm rule change log (ALARM_TITLES_AND_RULE_LOG_README.md Part B). Every create, edit and delete
// of an alarm rule is written to audit_log against the rule itself: entity_type alarm_rule,
// entity_uid the rule uid, entity_name the sensor name at the time. Always called inside the same
// transaction as the change, so a change and its log commit or roll back together.
// The database modules load inside the async functions, so the pure parts test without one.

const ENTITY = "alarm_rule";
const FIELDS = ["rule_kind", "direction", "threshold", "severity", "exceed_secs", "return_secs", "timeout_secs", "is_enabled", "use_default_group", "channel_policy", "alert_groups", "alarm_title"];

// A NULL policy means every channel on (notify.js rulePolicyAllows). The rule form has no SMS
// column (DECISIONS "SMS is hidden"), so saving an untouched rule writes email on, SMS off. The
// snapshot stores NULL as exactly that text, so the first save of an untouched rule is not logged
// as a change. Key order matches routes/sensors.js ruleFromBody.
const NULL_POLICY = JSON.stringify(
{
    raise: { email: true, sms: false },
    escalate: { email: true, sms: false },
    de_escalate: { email: true, sms: false },
    clear: { email: true, sms: false }
});

function text(v)
{
    return v === null || v === undefined ? null : String(v);
}

// Pure: a rule row (as the database returns it) and its alert group names to the audited
// snapshot. Every value is text or null; booleans are 1 and 0; groups are names, sorted.
function snapshotOf(rule, groupNames)
{
    const s = {};
    for (const f of FIELDS) { s[f] = text(rule[f]); }
    s.is_enabled = rule.is_enabled ? "1" : "0";
    s.use_default_group = rule.use_default_group ? "1" : "0";
    s.channel_policy = rule.channel_policy || NULL_POLICY;
    s.alert_groups = (groupNames || []).slice().sort().join(", ") || null;
    return s;
}

// Pure: the fields that differ, compared as text, NULL as NULL.
function diff(before, after)
{
    const out = [];
    for (const f of FIELDS)
    {
        if (before[f] !== after[f]) { out.push({ field: f, oldValue: before[f], newValue: after[f] }); }
    }
    return out;
}

// Read back from the database, so form values ("1", "on") and stored values compare alike.
async function snapshot(trx, ruleId)
{
    const { T } = require("../../db/knex");
    const rule = await trx(T("alarm_rules")).where({ id: ruleId }).first();
    if (!rule) { return null; }
    const names = await trx(T("alarm_rule_alert_groups") + " as rg").join(T("alert_groups") + " as g", "g.id", "rg.alert_group_id").where("rg.alarm_rule_id", ruleId).pluck("g.name");
    return { uid: String(rule.uid).toLowerCase(), values: snapshotOf(rule, names) };
}

function actorOf(user)
{
    return { actorType: "user", actorId: user.id, actorName: user.username };
}

function apiActor(credential)
{
    return { actorType: "api_credential", actorId: credential.id, actorName: credential.name };
}

const SYSTEM = { actorType: "system" };

function audit(trx, entry)
{
    return require("../audit").audit(trx, entry);
}

function whole(values, reason)
{
    return JSON.stringify(reason ? Object.assign({}, values, { reason: reason }) : values);
}

// One row, field created, the whole rule as JSON. Returns the rule uid.
async function created(trx, ruleId, sensorName, actor, reason)
{
    const s = await snapshot(trx, ruleId);
    await audit(trx, Object.assign({ entityType: ENTITY, entityUid: s.uid, entityName: sensorName, field: "created", newValue: whole(s.values, reason) }, actor));
    return s.uid;
}

// One row per changed field; nothing when nothing changed. before is snapshot() taken in the same
// transaction before the update. Returns the changed field names.
async function updated(trx, ruleId, before, sensorName, actor)
{
    const after = await snapshot(trx, ruleId);
    const changes = diff(before.values, after.values);
    for (const c of changes)
    {
        await audit(trx, Object.assign({ entityType: ENTITY, entityUid: after.uid, entityName: sensorName, field: c.field, oldValue: c.oldValue, newValue: c.newValue }, actor));
    }
    return changes.map((c) => c.field);
}

// One row, field deleted, the whole rule as JSON. The rule is soft deleted, so its row stays.
async function deleted(trx, ruleId, sensorName, actor, reason)
{
    const s = await snapshot(trx, ruleId);
    await audit(trx, Object.assign({ entityType: ENTITY, entityUid: s.uid, entityName: sensorName, field: "deleted", oldValue: whole(s.values, reason) }, actor));
    return s.uid;
}

// Sensor, device and location delete: each live rule on these sensors is logged as deleted with
// the reason ("sensor deleted", "device deleted", "location deleted"), then soft deleted, so it
// can be restored later. sensorIds is an array or a subquery; call it before the sensors are
// marked deleted. Returns how many rules were removed.
async function deleteForSensors(trx, sensorIds, actor, reason, now)
{
    const { T } = require("../../db/knex");
    const rules = await trx(T("alarm_rules") + " as r").join(T("sensors") + " as s", "s.id", "r.sensor_id")
        .whereIn("r.sensor_id", sensorIds).whereNull("r.delete_epoch").select("r.id", "s.name as sensor_name");
    for (const r of rules)
    {
        await deleted(trx, r.id, r.sensor_name, actor, reason);
    }
    if (rules.length)
    {
        await trx(T("alarm_rules")).whereIn("id", rules.map((r) => r.id)).update({ delete_epoch: now });
    }
    return rules.length;
}

module.exports = { ENTITY, FIELDS, NULL_POLICY, snapshotOf, diff, snapshot, actorOf, apiActor, SYSTEM, created, updated, deleted, deleteForSensors };
