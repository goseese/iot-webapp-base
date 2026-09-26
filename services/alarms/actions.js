// Manual actions (architecture 8.2, 8.7): acknowledge for N minutes, ignore, clear. All need a
// comment. actor: { type: "user" | "api_credential", id, name }.
const { knex, T, nowEpoch } = require("../../db/knex");
const alarmsRepo = require("../../db/repos/alarms");
const ladder = require("./ladder");
const engine = require("./engine");

async function acknowledge(alarm, minutes, comment, actor)
{
    const now = nowEpoch();
    const until = now + Math.max(5, Math.min(minutes, 1440)) * 60;
    await knex.transaction(async (trx) =>
    {
        await alarmsRepo.updateAlarm(alarm.id, { acked_by: actor.type === "user" ? actor.id : null, acked_epoch: now, ack_until_epoch: until }, trx);
        await alarmsRepo.insertEvent({ alarm_id: alarm.id, epoch: now, event_kind: "acknowledged", severity: alarm.severity, actor_type: actor.type, actor_id: actor.id, comment: comment }, trx);
        await trx(T("alarm_escalations")).where({ alarm_id: alarm.id }).update({ is_stopped: 1 });
    });
}

// Seen, not responding: mutes that person for this alarm; the ladder continues for others.
async function ignore(alarm, comment, actor)
{
    const now = nowEpoch();
    await alarmsRepo.insertEvent({ alarm_id: alarm.id, epoch: now, event_kind: "ignored", severity: alarm.severity, actor_type: actor.type, actor_id: actor.id, comment: comment });
}

// Manual clear cancels the alarm and zeroes every breach clock for that sensor and direction.
async function clear(alarm, comment, actor)
{
    const now = nowEpoch();
    const rules = (await alarmsRepo.rulesForSensor(alarm.sensor_id)).filter((r) => r.rule_kind === "threshold" && r.direction === alarm.direction);
    ladder.zeroClocks(rules);
    for (const r of rules) { await alarmsRepo.saveRuleClocks(r); }
    return engine.clear(alarm, now, "manual", actor, comment);
}

async function ignoredBy(alarmId, actorType, actorId)
{
    const r = await knex(T("alarm_events")).where({ alarm_id: alarmId, event_kind: "ignored", actor_type: actorType, actor_id: actorId }).first();
    return !!r;
}

module.exports = { acknowledge, ignore, clear, ignoredBy };
