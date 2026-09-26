// Stage 5: threshold evaluation over everything written this pass, plus in-pipeline no_data
// clear on new data (architecture 8.1, 8.2, 8.3).
const { knex, T } = require("../db/knex");
const alarmsRepo = require("../db/repos/alarms");
const ladder = require("../services/alarms/ladder");
const engine = require("../services/alarms/engine");
const armed = require("../services/alarms/armed");

async function evaluate(device, accepted, epoch)
{
    if (accepted.length === 0) { return []; }
    const transitions = [];
    const location = await knex(T("locations")).where({ id: device.location_id }).first();
    const tz = location ? location.iana_timezone : "UTC";

    for (const a of accepted)
    {
        const sensor = { id: a.sensorId, device_id: device.id };
        const rules = await alarmsRepo.rulesForSensor(a.sensorId);

        // Data arrived: any active no_data alarm on this sensor clears here, not in the minute job.
        const noData = await alarmsRepo.activeForSensor(a.sensorId, "no_data");
        if (noData)
        {
            const t = await engine.clear(noData, epoch, "returned", null, null, a.value);
            if (t) { transitions.push(t); }
        }
        if (location && location.alarm_mode === "offline") { continue; }   // readings log, nothing is evaluated

        for (const direction of ["upper", "lower"])
        {
            const dirRules = rules.filter((r) => r.rule_kind === "threshold" && r.direction === direction);
            const active = await alarmsRepo.activeForSensor(a.sensorId, direction);
            if (dirRules.length === 0)
            {
                if (active) { const t = await engine.clear(active, epoch, "returned", null, "rule removed"); if (t) { transitions.push(t); } }
                continue;
            }

            // Disarm: readings still log; no evaluation; active alarm clears with the reason (8.3).
            const disarmed = await armed.disarmReason(device, active ? dirRules.find((r) => r.id === active.rule_id) : null, epoch, tz, location);
            if (disarmed)
            {
                ladder.zeroClocks(dirRules);
                for (const r of dirRules) { await alarmsRepo.saveRuleClocks(r); }
                if (active) { const t = await engine.clear(active, epoch, "disarmed", null, "disarmed: " + disarmed, a.value); if (t) { transitions.push(t); } }
                continue;
            }

            const result = ladder.evaluate(dirRules, active, a.value, a.epoch);
            for (const r of result.changedRules) { await alarmsRepo.saveRuleClocks(r); }

            let t = null;
            if (result.transition === "raise") { t = await engine.raise(sensor, direction, result.rule, result.severity, a.value, a.epoch); }
            else if (result.transition === "escalate") { t = await engine.reseverity(active, result.rule, result.severity, a.value, a.epoch, "escalated"); }
            else if (result.transition === "de_escalate") { t = await engine.reseverity(active, result.rule, result.severity, a.value, a.epoch, "de_escalated"); }
            else if (result.transition === "clear") { t = await engine.clear(active, a.epoch, "returned", null, null, a.value); }
            if (t) { transitions.push(t); }
        }
    }
    return transitions;
}

module.exports = { evaluate };
