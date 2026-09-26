// Applies ladder transitions to the database (architecture 8.2, 8.5): alarm rows, append only
// events, escalation rows at level 1, then notification resolution. Every function here is
// the only way an alarm changes state; routes and jobs call in, never write alarms directly.
const { knex, T } = require("../../db/knex");
const alarmsRepo = require("../../db/repos/alarms");
const notify = require("./notify");
const logger = require("../../config/logger");

// Escalation rows per attached group at level 1 (restart on raise or severity change).
// Runs after the alarm row is committed; group resolution reads across several tables.
async function startLadders(alarmId, epoch)
{
    const ctx = await alarmsRepo.context(alarmId);
    const groups = await notify.attachedGroups(ctx);
    await knex(T("alarm_escalations")).where({ alarm_id: alarmId }).del();
    for (const g of groups)
    {
        await knex(T("alarm_escalations")).insert({ alarm_id: alarmId, alert_group_id: g.id, current_level: 1, level_entered_epoch: epoch, is_stopped: 0 });
    }
}

async function raise(sensor, direction, rule, severity, value, epoch, extra)
{
    const suppressedBy = extra && extra.suppressedBy ? extra.suppressedBy : null;
    let alarmId = null;
    let eventId = null;
    await knex.transaction(async (trx) =>
    {
        try
        {
            alarmId = await alarmsRepo.insertAlarm({ sensor_id: sensor.id, direction: direction, severity: severity, rule_id: rule ? rule.id : null, raised_epoch: epoch, trigger_value: value === undefined ? null : value, suppressed_by: suppressedBy }, trx);
        }
        catch (err)
        {
            if (err.number === 2601 || err.number === 2627) { return; }   // already active: lost a race, fine
            throw err;
        }
        eventId = await alarmsRepo.insertEvent({ alarm_id: alarmId, epoch: epoch, event_kind: suppressedBy ? "suppressed" : "raised", severity: severity, value: value === undefined ? null : value, actor_type: "system" }, trx);
    });
    if (alarmId === null) { return null; }
    if (!suppressedBy)
    {
        await startLadders(alarmId, epoch);
        await notify.notify(alarmId, { eventId: eventId, eventKind: "raised", severity: severity, value: value });
    }
    return { alarmId: alarmId, kind: suppressedBy ? "suppressed" : "raised", severity: severity, sensorId: sensor.id };
}

// Escalate or de-escalate in place: same row, severity changes, ack reset, ladder restarts.
async function reseverity(active, rule, severity, value, epoch, kind)
{
    let eventId = null;
    await knex.transaction(async (trx) =>
    {
        await alarmsRepo.updateAlarm(active.id, { severity: severity, rule_id: rule ? rule.id : active.rule_id, acked_by: null, acked_epoch: null, ack_until_epoch: null }, trx);
        eventId = await alarmsRepo.insertEvent({ alarm_id: active.id, epoch: epoch, event_kind: kind, severity: severity, value: value === undefined ? null : value, actor_type: "system" }, trx);
    });
    if (kind === "escalated") { await startLadders(active.id, epoch); }
    if (!active.suppressed_by) { await notify.notify(active.id, { eventId: eventId, eventKind: kind, severity: severity, value: value }); }
    return { alarmId: active.id, kind: kind, severity: severity, sensorId: active.sensor_id };
}

// reason: returned | manual | offline | disarmed | archived | gateway_recovered
async function clear(active, epoch, reason, actor, comment, value)
{
    let eventId = null;
    await knex.transaction(async (trx) =>
    {
        const n = await trx(T("alarms")).where({ id: active.id }).whereNull("cleared_epoch").update({ cleared_epoch: epoch, clear_reason: reason });
        if (n === 0) { return; }
        eventId = await alarmsRepo.insertEvent({ alarm_id: active.id, epoch: epoch, event_kind: "cleared", severity: active.severity, value: value === undefined ? null : value,
            actor_type: actor ? actor.type : "system", actor_id: actor ? actor.id : null, comment: comment || ("cleared: " + reason) }, trx);
        await trx(T("alarm_escalations")).where({ alarm_id: active.id }).update({ is_stopped: 1 });
        // Suppressed device alarms hanging off a cleared gateway alarm are revisited by the no_data task.
    });
    if (eventId === null) { return null; }
    const silent = !!active.suppressed_by || reason === "gateway_recovered";
    if (!silent) { await notify.notify(active.id, { eventId: eventId, eventKind: "cleared", severity: active.severity, value: value, comment: comment }); }
    logger.info({ alarm: active.id, reason: reason }, "alarm cleared");
    return { alarmId: active.id, kind: "cleared", severity: active.severity, sensorId: active.sensor_id };
}

async function clearAllForDevice(deviceId, epoch, reason, actor, comment)
{
    const out = [];
    for (const a of await alarmsRepo.activeForDevice(deviceId))
    {
        const t = await clear(a, epoch, reason, actor, comment);
        if (t) { out.push(t); }
    }
    return out;
}

module.exports = { raise, reseverity, clear, clearAllForDevice, startLadders };
