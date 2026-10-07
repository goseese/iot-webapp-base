// Chart emails sent from the site (services/chartEmail.js, DECISIONS.md "Chart email from the site").
// A send is in scope when any sensor in its data is one of the report's sensors. Times in UTC: a
// send can cover several locations.
const { knex, T } = require("../db/knex");

// The send rows in the window whose data touches the report's sensors.
async function sends(q)
{
    if (!q.sensorIds || !q.sensorIds.length) { return []; }
    const overlap = "e.sensor_ids && ARRAY[" + q.sensorIds.map(() => "?").join(", ") + "]::int[]";
    return knex(T("chart_emails") + " as e").join(T("users") + " as u", "u.id", "e.user_id")
        .leftJoin(T("sensors") + " as s", "s.id", "e.sensor_id").leftJoin(T("charts") + " as c", "c.id", "e.chart_id")
        .whereRaw(overlap, q.sensorIds.map(Number)).where("e.epoch", ">=", q.fromEpoch).where("e.epoch", "<=", q.toEpoch)
        .select("e.*", "u.username", "u.display_name", "s.name as sensor_name", "c.name as chart_name").orderBy("e.epoch");
}

function utc(epoch) { return new Date(Number(epoch) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"; }

module.exports =
{
    slug: "chart_emails",
    displayName: "Chart emails",
    description: "Every chart emailed from the site in the window: who sent it, to whom, which chart and window, and whether it went.",
    columns: ["Sent (UTC)", "User", "Recipients", "Subject", "Chart", "Window (UTC)", "Readings", "Format", "Outcome"],
    sends: sends,
    async rows(q)
    {
        return (await sends(q)).map((e) => [utc(e.epoch), e.display_name || e.username, e.recipients, e.subject,
            e.source === "sensor" ? (e.sensor_name || "deleted sensor") : (e.chart_name || "deleted chart"),
            utc(e.from_epoch) + " to " + utc(e.to_epoch), e.reading_count, e.format, e.outcome + (e.reason ? ": " + e.reason : "")]);
    }
};
