// One interface, one module per provider (conventions.md section 8). Every send writes
// notifications first, then sends, then records the outcome. The driver and its
// credentials come from site settings (Email tab); .env keys of the same names override.
const env = require("../../config/env");
const settings = require("../../config/settings");
const logger = require("../../config/logger");
const notifications = require("../../db/repos/notifications");

const drivers =
{
    none: require("./none"),
    ses: require("./ses"),
    sendgrid: require("./sendgrid"),
    smtp: require("./smtp")
};

function chosen()
{
    return drivers[settings.get("MAIL_DRIVER", "none")] || drivers.none;
}

// The driver that will actually send: the chosen one if configured, else none (logged).
function active()
{
    const d = chosen();
    return d.configured() ? d : drivers.none;
}

function fromAddress()
{
    return settings.get("MAIL_FROM_ADDRESS", "") || env.mail.resetFrom || env.mail.supportFrom || "no-reply@localhost";
}

// msg: { to, subject, text, html?, kind, recipientType, recipientId?, from?, fromName?, replyTo?, alarmEventId?, ladderNote?, attachments? }
// fromName: the sender name shown on the site address ("Jeff Seese via Voltastc", chart email); default the MAIL_FROM_NAME setting.
// attachments: optional list of { filename, contentType, data (Buffer), cid? } (support requests, chart
// email). With cid the file is inline: the HTML shows it with <img src="cid:<cid>"> (alarm chart).
// to is one address or a list; a list goes out as one message with every address in To (support
// mail, so the team can reply all). replyTo is an optional address or list.
async function send(msg)
{
    const driver = active();
    const to = [].concat(msg.to || []).map((a) => String(a).trim()).filter((a) => a.length > 0);
    const replyTo = [].concat(msg.replyTo || []).map((a) => String(a).trim()).filter((a) => a.length > 0);
    const notConfigured = driver.name === "none" && chosen().name !== "none";
    const id = await notifications.insert(
    {
        kind: msg.kind, channel: "email", recipient_type: msg.recipientType || "address", recipient_id: msg.recipientId || null,
        address: to.join(", ").slice(0, 254), alarm_event_id: msg.alarmEventId || null, ladder_note: msg.ladderNote || null,
        outcome: "failed", reason: "not attempted", provider: driver.name, subject: (msg.subject || "").slice(0, 255)
    });
    if (notConfigured)
    {
        await notifications.update(id, { outcome: "failed", reason: "mail driver " + chosen().name + " is not configured (Admin, Site settings, Email)" });
        return { ok: false, notificationId: id, reason: "mail driver not configured" };
    }
    try
    {
        const result = await driver.send({ to: to, replyTo: replyTo, from: msg.from || fromAddress(), fromName: msg.fromName || settings.get("MAIL_FROM_NAME", "") || settings.siteName(), subject: msg.subject, text: msg.text, html: msg.html || null, attachments: msg.attachments || [] });
        await notifications.update(id, { outcome: "sent", reason: null, provider_message_id: result.messageId });
        return { ok: true, notificationId: id };
    }
    catch (err)
    {
        // AWS SDK errors carry the SES error code in err.name (MessageRejected, AccessDeniedException, ...).
        // The notification row's reason column holds 200 characters, so the full text also goes in
        // provider_response (the notification detail view) and back to the caller, which shows it and
        // puts it in the event log: an AccessDenied message names the refused resource at its end.
        const full = (err.name && err.name !== "Error" ? err.name + ": " : "") + (err.message || "send failed");
        logger.error({ err: err.message, to: to, driver: driver.name }, "mail send failed");
        await notifications.update(id, { outcome: "failed", reason: full.slice(0, 190), provider_response: full.slice(0, 8000) });
        return { ok: false, notificationId: id, reason: full.slice(0, 2000) };
    }
}

module.exports = { send, active, chosen, drivers, fromAddress };
