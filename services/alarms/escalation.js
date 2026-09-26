// Minute job: advance ladders for unacknowledged alarms, expire acknowledgement windows,
// re-notify after RENOTIFY_MINUTES (architecture 8.5, 8.6, 8.7).
const settings = require("../../config/settings");
const { knex, T, nowEpoch } = require("../../db/knex");
const alarmsRepo = require("../../db/repos/alarms");
const notify = require("./notify");
const engine = require("./engine");

async function offlineAlarmIds()
{
    const rows = await knex(T("alarms") + " as a").join(T("sensors") + " as s", "s.id", "a.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id")
        .whereNull("a.cleared_epoch").where("l.alarm_mode", "offline").select("a.id");
    return new Set(rows.map((r) => r.id));
}

async function run()
{
    const now = nowEpoch();
    const skip = await offlineAlarmIds();

    // Ack windows that ran out with the alarm still active: ladder restarts, re-notify resumes.
    const expired = await knex(T("alarms")).whereNull("cleared_epoch").whereNotNull("ack_until_epoch").where("ack_until_epoch", "<", now).whereNull("suppressed_by");
    for (const a of expired)
    {
        if (skip.has(a.id)) { continue; }
        await knex(T("alarms")).where({ id: a.id }).update({ acked_by: null, acked_epoch: null, ack_until_epoch: null });
        const eventId = await alarmsRepo.insertEvent({ alarm_id: a.id, epoch: now, event_kind: "re_notified", severity: a.severity, actor_type: "system", comment: "acknowledgement window expired" });
        await engine.startLadders(a.id, now);
        await notify.notify(a.id, { eventId: eventId, eventKind: "re_notified", severity: a.severity, value: a.trigger_value, comment: "Acknowledgement expired and the alarm is still active." });
    }

    // Ladder advancement for active, unacknowledged, unsuppressed alarms.
    const escalations = await knex(T("alarm_escalations") + " as e").join(T("alarms") + " as a", "a.id", "e.alarm_id")
        .whereNull("a.cleared_epoch").whereNull("a.acked_epoch").whereNull("a.suppressed_by").where("e.is_stopped", 0)
        .select("e.*", "a.severity", "a.trigger_value");
    for (const e of escalations)
    {
        if (skip.has(e.alarm_id)) { continue; }
        const next = await knex(T("alert_group_levels")).where({ alert_group_id: e.alert_group_id, level_no: e.current_level + 1 }).first();
        if (!next) { continue; }
        if (now - e.level_entered_epoch < next.wait_minutes * 60) { continue; }
        await knex(T("alarm_escalations")).where({ id: e.id }).update({ current_level: next.level_no, level_entered_epoch: now });
        const eventId = await alarmsRepo.insertEvent({ alarm_id: e.alarm_id, epoch: now, event_kind: "re_notified", severity: e.severity, actor_type: "system", comment: "escalation ladder level " + next.level_no });
        const upto = {}; upto[e.alert_group_id] = next.level_no;
        await notify.notify(e.alarm_id, { eventId: eventId, eventKind: "re_notified", severity: e.severity, value: e.trigger_value, uptoLevelByGroup: upto });
    }

    // Periodic re-notification for unacknowledged alarms with no further ladder movement.
    const renotify = settings.get("RENOTIFY_MINUTES", 60) * 60;
    const stale = await knex(T("alarms")).whereNull("cleared_epoch").whereNull("acked_epoch").whereNull("suppressed_by")
        .whereNotNull("last_notified_epoch").where("last_notified_epoch", "<", now - renotify);
    for (const a of stale)
    {
        if (skip.has(a.id)) { continue; }
        const eventId = await alarmsRepo.insertEvent({ alarm_id: a.id, epoch: now, event_kind: "re_notified", severity: a.severity, actor_type: "system", comment: "still active and unacknowledged" });
        await notify.notify(a.id, { eventId: eventId, eventKind: "re_notified", severity: a.severity, value: a.trigger_value });
    }
}

module.exports = { run };
