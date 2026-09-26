// Report execution (architecture 9): resolve the sensor set from the saved query (location +
// tag query), run the type, write CSV or HTML to storage/reports, record the run, email a link.
const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const settings = require("../config/settings");
const { knex, T, nowEpoch, insertId } = require("../db/knex");
const reportTypes = require("../reportTypes");
const tags = require("./tags");
const mail = require("./mail");

const DIR = path.join(__dirname, "..", "storage", "reports");

async function resolveSensorIds(query, accountId)
{
    const q = knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id")
        .where("l.account_id", accountId).whereNull("s.delete_epoch").whereNull("d.delete_epoch").where("d.is_archived", 0).where("s.is_hidden", 0).select("s.id", "s.name", "s.device_id");
    if (query.locationId) { q.where("l.id", query.locationId); }
    const rows = await q;
    const tq = tags.parseQuery(query.tagQuery);
    if (!tq || (!tq.any.length && !tq.all.length && !tq.none.length && !tq.text)) { return rows.map((r) => r.id); }
    const out = [];
    for (const r of rows) { if (tags.matches(tq, await tags.effectiveForSensor(r), r.name)) { out.push(r.id); } }
    return out;
}

function csvEscape(v) { const s = String(v === null || v === undefined ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

function toCsv(columns, rows) { return [columns.map(csvEscape).join(",")].concat(rows.map((r) => r.map(csvEscape).join(","))).join("\r\n") + "\r\n"; }

function toHtml(title, columns, rows, meta)
{
    const esc = (v) => String(v === null || v === undefined ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return "<!doctype html><html><head><meta charset='utf-8'><title>" + esc(title) + "</title><style>body{font-family:system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;font-size:13px;text-align:left}th{background:#f3f4f6}h1{font-size:20px}p{color:#666;font-size:13px}</style></head><body>" +
        "<h1>" + esc(title) + "</h1><p>" + esc(meta) + "</p><table><thead><tr>" + columns.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table></body></html>";
}

// windowDays from the saved query; "yesterday" style windows end at the run time.
async function run(report, triggerKind, actorUser)
{
    const started = nowEpoch();
    const query = JSON.parse(report.query_json);
    const type = reportTypes.get(report.report_type);
    let runId = null;
    try
    {
        const to = started;
        const from = to - Math.max(1, Number(query.windowDays) || 1) * 86400;
        const sensorIds = await resolveSensorIds(query, report.account_id);
        const rows = await type.rows({ sensorIds: sensorIds, fromEpoch: from, toEpoch: to, locationIds: query.locationId ? [query.locationId] : null });
        fs.mkdirSync(DIR, { recursive: true });
        const ext = report.output_kind === "csv" ? "csv" : "html";
        const file = String(report.uid).toLowerCase() + "-" + started + "." + ext;
        const meta = type.displayName + " for " + rows.length + " row" + (rows.length === 1 ? "" : "s") + ", " + new Date(from * 1000).toISOString().slice(0, 16) + " to " + new Date(to * 1000).toISOString().slice(0, 16) + " UTC";
        fs.writeFileSync(path.join(DIR, file), ext === "csv" ? toCsv(type.columns, rows) : toHtml(report.name, type.columns, rows, meta));
        const r = await knex(T("report_runs")).insert({ report_id: report.id, epoch: started, trigger_kind: triggerKind, outcome: "ok", row_count: rows.length, file_path: file }).returning("id");
        runId = insertId(r);
        await knex(T("reports")).where({ id: report.id }).update({ last_run_epoch: started });

        const recipients = await knex(T("report_recipients")).where({ report_id: report.id });
        for (const rc of recipients)
        {
            const row = rc.recipient_type === "user" ? await knex(T("users")).where({ id: rc.recipient_id }).whereNull("delete_epoch").first() : await knex(T("contacts")).where({ id: rc.recipient_id }).whereNull("delete_epoch").first();
            if (!row || !row.email) { continue; }
            await mail.send({ kind: "report", to: row.email, recipientType: rc.recipient_type, recipientId: rc.recipient_id, subject: settings.get("SITE_NAME", "DevMon") + " report: " + report.name,
                text: report.name + " (" + type.displayName + ") has run: " + rows.length + " rows.\n\nDownload: " + env.appUrl + "/reports/" + String(report.uid).toLowerCase() + "/runs/" + runId + "\n" });
        }
        return { ok: true, runId: runId, rows: rows.length };
    }
    catch (err)
    {
        await knex(T("report_runs")).insert({ report_id: report.id, epoch: started, trigger_kind: triggerKind, outcome: "failed", error: String(err.message).slice(0, 500) });
        return { ok: false, error: err.message };
    }
}

// Scheduled runs: schedule_json = { mode: "daily" | "weekly", time: "07:00", days: [1..5] } in the
// report location's timezone (account timezone = first location) checked each minute.
async function runDue()
{
    const now = nowEpoch();
    const reports = await knex(T("reports")).whereNull("delete_epoch").where("is_enabled", 1).whereNotNull("schedule_json");
    for (const r of reports)
    {
        let sch; try { sch = JSON.parse(r.schedule_json); } catch (err) { continue; }
        if (!sch || !sch.time) { continue; }
        const loc = r.location_id ? await knex(T("locations")).where({ id: r.location_id }).first() : await knex(T("locations")).where({ account_id: r.account_id }).whereNull("delete_epoch").first();
        const tz = loc ? loc.iana_timezone : "UTC";
        const local = require("./alarms/armed").localDowMinute(now, tz);
        const [hh, mm] = sch.time.split(":").map(Number);
        if (local.minute !== hh * 60 + mm) { continue; }
        if (sch.mode === "weekly" && !(sch.days || []).includes(local.dow)) { continue; }
        if (r.last_run_epoch && now - Number(r.last_run_epoch) < 120) { continue; }   // same minute guard
        await run(r, "schedule", null);
    }
}

module.exports = { run, runDue, resolveSensorIds, DIR };
