// Draws the alarm email chart for one alarm to a PNG file, to check how it looks without waiting for
// an alarm (services/alarms/chartImage.js). Sends nothing and writes nothing to the database.
// node scripts/alarm-chart.js <alarm uid> [raised|cleared] [out.png]
// raised: the window ends at the raise; cleared: at the clear (the alarm must be cleared).
const fs = require("fs");
const { knex, T } = require("../db/knex");
const settings = require("../config/settings");
const alarmsRepo = require("../db/repos/alarms");
const title = require("../services/alarms/title");
const chartImage = require("../services/alarms/chartImage");

(async () =>
{
    const [uid, kindArg, outArg] = process.argv.slice(2);
    const kind = kindArg || "raised";
    if (!uid || !["raised", "cleared"].includes(kind))
    {
        console.error("usage: node scripts/alarm-chart.js <alarm uid> [raised|cleared] [out.png]");
        process.exit(1);
    }
    await settings.reload();
    const alarm = await knex(T("alarms")).where({ uid: uid }).first();
    if (!alarm) { throw new Error("alarm not found: " + uid); }
    if (kind === "cleared" && !alarm.cleared_epoch) { throw new Error("that alarm is still active; use raised"); }
    const ctx = await alarmsRepo.context(alarm.id);
    const rule = ctx.rule_id ? await knex(T("alarm_rules")).where({ id: ctx.rule_id }).first() : null;
    if (!rule || rule.rule_kind !== "threshold") { throw new Error("only threshold alarms get a chart"); }
    if (!rule.chart_in_alarm) { console.log("note: this rule has Include chart in alarm off; drawing it anyway"); }
    const end = Number(kind === "cleared" ? alarm.cleared_epoch : alarm.raised_epoch);
    const img = await chartImage.forAlarm(ctx, Object.assign({}, rule, { chart_in_alarm: true }), kind, end, await title.forAlarm(ctx, rule));
    if (!img) { throw new Error("the chart could not be drawn; see the log line above"); }
    const out = outArg || "/tmp/" + img.filename;
    fs.writeFileSync(out, img.data);
    console.log("wrote " + out + " (" + img.data.length + " bytes), window " + new Date(img.from * 1000).toISOString() + " to " + new Date(img.to * 1000).toISOString());
    await knex.destroy();
})().catch((err) => { console.error(err.message); process.exit(1); });
