// Chart email sent from the site (DECISIONS.md "Chart email from the site"): Share > Email... >
// Send from <site>. One message to up to 5 recipients, From the site address under the user's
// name, Reply-To the user, with the chart image the browser drew and the readings in the window,
// built here from the database. Every send is a chart_emails row (daily limit, reports) and a
// notifications row (the mail service's send log). Answers { status, body } for a JSON reply.
const multer = require("multer");
const settings = require("../config/settings");
const env = require("../config/env");
const mail = require("./mail");
const activity = require("./activity");
const sensorsExt = require("../db/repos/sensorsExt");
const { MAX_RECIPIENTS, hasLink, cleanText, parseRecipients, isPng, tzOf, localTime, epochOf, toCsv, toJson, zipOne, slug, esc } = require("./chartEmailHelpers");
const { knex, T, nowEpoch, insertId } = require("../db/knex");

const MAX_NAME = 200;
const MAX_COMMENT = 4000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_READINGS = 100000;            // per sensor, newest kept: the charts' ceiling
const MAX_WINDOW_SECS = 400 * 86400;
const DAY_SECS = 86400;
const FORMATS =
{
    csv: { ext: ".csv", type: "text/csv", label: "CSV" },
    json: { ext: ".json", type: "application/json", label: "JSON" },
    csvzip: { ext: ".csv.zip", type: "application/zip", label: "CSV in a .zip", zip: true },
    jsonzip: { ext: ".json.zip", type: "application/zip", label: "JSON in a .zip", zip: true }
};

// The chart image as one multipart file named "image"; errors answer JSON like the rest.
const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 12 } }).single("image");
function upload(req, res, next)
{
    uploader(req, res, (err) =>
    {
        if (!err) { return next(); }
        const big = err.code === "LIMIT_FILE_SIZE";
        res.status(big ? 413 : 400).json({ ok: false, error: big ? "The chart image is too large to send." : "The request could not be read." });
    });
}

// A one time limit while it lasts (users.chart_email_limit_once until chart_email_limit_once_until,
// set on Administration > Users), else the user's own limit when set
// (users.chart_email_daily_limit), else the site setting.
function limitFor(user, now)
{
    const at = now || Math.floor(Date.now() / 1000);
    if (user.chart_email_limit_once !== null && user.chart_email_limit_once !== undefined && Number(user.chart_email_limit_once_until) > at) { return Number(user.chart_email_limit_once); }
    if (user.chart_email_daily_limit !== null && user.chart_email_daily_limit !== undefined) { return Number(user.chart_email_daily_limit); }
    return Number(settings.get("CHART_EMAIL_DAILY_LIMIT", 20));
}
async function sentInLastDay(userId, now)
{
    const r = await knex(T("chart_emails")).where({ user_id: userId, outcome: "sent" }).where("epoch", ">", now - DAY_SECS).count({ n: "*" }).first();
    return Number(r.n);
}

// Readings in [from, to] for each series, in display units: rows for the file.
async function dataRows(series, from, to, tz, withSeries)
{
    const rows = [];
    for (const s of series)
    {
        const readings = await sensorsExt.readings(s.id, from, to, MAX_READINGS);
        for (const r of readings)
        {
            const epoch = Number(r.epoch);
            const value = Number(Number(s.toDisplay(r.value)).toFixed(4));
            const row = [localTime(epoch, tz), epoch, value, s.unit || ""];
            rows.push(withSeries ? [s.name].concat(row) : row);
        }
    }
    return rows;
}

// input: { accountId, source: "sensor" | "chart", sensorId, chartId, uid, title, tz, series: [{ id, name,
// unit, toDisplay(v) }], path (the chart page), from, to (epoch seconds), image (Buffer) }; the form
// fields come from req.body: to, name, comment, format.
async function send(req, input)
{
    const user = await knex(T("users")).where({ id: req.user.id }).first();
    const site = settings.siteName();
    const now = nowEpoch();

    const rcpt = parseRecipients(req.body.to);
    if (rcpt.error) { return { status: 400, body: { ok: false, error: rcpt.error } }; }
    const name = cleanText(req.body.name, MAX_NAME);
    const comment = cleanText(req.body.comment, MAX_COMMENT);
    if (hasLink(name) || hasLink(comment))
    {
        return { status: 400, body: { ok: false, error: "Links cannot be included in the name or comment. A name such as maintenance.com is fine; a full address (http://, https://, www.) is not." } };
    }
    const format = FORMATS[req.body.format] ? req.body.format : "csv";
    const from = input.from, to = input.to;
    if (from === null || to === null || from >= to || to > now + 60 || to - from > MAX_WINDOW_SECS)
    {
        return { status: 400, body: { ok: false, error: "The chart window could not be read. Reload the page and try again." } };
    }
    if (!isPng(input.image)) { return { status: 400, body: { ok: false, error: "The chart image is missing. Reload the page and try again." } }; }
    if (!input.series.length) { return { status: 400, body: { ok: false, error: "This chart has no sensors you can see." } }; }

    const limit = limitFor(user, now);
    const used = await sentInLastDay(user.id, now);
    if (used >= limit)
    {
        activity.log(req, "chart_email", { outcome: "refused", entity_type: input.source, entity_uid: input.uid, detail: "daily limit " + limit + " reached" });
        return { status: 429, body: { ok: false, limit: limit, limitReached: true, error: "You have reached your daily limit of " + limit + " chart email" + (limit === 1 ? "" : "s") + " sent from " + site + ". Ask support to raise it, or try again tomorrow." } };
    }

    const tz = input.tz;
    const withSeries = input.source === "chart";
    const headers = (withSeries ? ["Series"] : []).concat(["Time (" + tz + ")", "Epoch", "Value", "Unit"]);
    const rows = await dataRows(input.series, from, to, tz, withSeries);
    if (!rows.length) { return { status: 400, body: { ok: false, error: "There are no readings in this window to send." } }; }

    const sender = user.display_name || user.username;
    const windowText = localTime(from, tz).slice(0, 16) + " to " + localTime(to, tz).slice(0, 16) + " (" + tz + ")";
    const subject = name || (input.title + ", " + windowText).slice(0, MAX_NAME);
    const base = slug(input.title) + "-" + localTime(from, tz).slice(0, 16).replace(/[ :]/g, "-") + "-to-" + localTime(to, tz).slice(0, 16).replace(/[ :]/g, "-");
    const f = FORMATS[format];
    const inner = format.indexOf("json") === 0 ? Buffer.from(toJson(headers, rows), "utf8") : Buffer.from(toCsv(headers, rows), "utf8");
    const dataFile = { filename: base + f.ext, contentType: f.type, data: f.zip ? zipOne(base + f.ext.replace(".zip", ""), inner) : inner };
    const imageFile = { filename: base + ".png", contentType: "image/png", data: input.image };
    const link = env.appUrl.replace(/\/+$/, "") + input.path + "?from=" + from + "&to=" + to;
    const what = "the chart image (" + imageFile.filename + ") and " + rows.length.toLocaleString("en-US") + " readings from " + windowText + " as " + f.label + " (" + dataFile.filename + ")";

    const text = [sender + " wants to share a chart with you.", "", "Name: " + subject]
        .concat(comment ? ["", "Comment:", comment] : [])
        .concat(["", "View the chart on " + site + " (sign in needed):", link, "", "Attached: " + what + ".", "Replies to this email go to " + sender + "."]).join("\n");
    const html = '<div style="font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.5">' +
        "<p>" + esc(sender) + " wants to share a chart with you.</p>" +
        "<p><strong>Name:</strong> " + esc(subject) + "</p>" +
        (comment ? '<p><strong>Comment:</strong></p><p style="white-space: pre-wrap">' + esc(comment) + "</p>" : "") +
        '<p>View the chart on ' + esc(site) + ' (sign in needed):<br><a href="' + esc(link) + '">' + esc(link) + "</a></p>" +
        "<p>Attached: " + esc(what) + ".</p>" +
        "<p>Replies to this email go to " + esc(sender) + ".</p></div>";

    const id = insertId(await knex(T("chart_emails")).insert(
    {
        epoch: now, user_id: user.id, account_id: input.accountId, source: input.source, sensor_id: input.sensorId || null, chart_id: input.chartId || null,
        sensor_ids: input.series.map((s) => s.id), from_epoch: from, to_epoch: to, recipients: rcpt.list.join(", "), recipient_count: rcpt.list.length,
        subject: subject, comment: comment || null, format: format, reading_count: rows.length, outcome: "failed", reason: "not attempted"
    }).returning("id"));
    const result = await mail.send(
    {
        to: rcpt.list, subject: subject, text: text, html: html, kind: "chart_email", recipientType: "address",
        replyTo: user.email, fromName: sender + " via " + site, attachments: [imageFile, dataFile]
    });
    await knex(T("chart_emails")).where({ id: id }).update({ notification_id: result.notificationId || null, outcome: result.ok ? "sent" : "failed", reason: result.ok ? null : String(result.reason || "send failed").slice(0, 200) });
    activity.log(req, "chart_email", { outcome: result.ok ? "ok" : "failed", entity_type: input.source, entity_uid: input.uid, detail: rcpt.list.length + " recipient(s), " + rows.length + " readings, " + format + (result.ok ? "" : ": " + String(result.reason || "").slice(0, 200)) });
    if (!result.ok) { return { status: 502, body: { ok: false, error: "The email could not be sent: " + (result.reason || "send failed") } }; }
    return { status: 200, body: { ok: true, sent: rcpt.list.length, readings: rows.length, used: used + 1, limit: limit } };
}

module.exports = { MAX_RECIPIENTS, MAX_IMAGE_BYTES, FORMATS, upload, tzOf, epochOf, limitFor, send };
