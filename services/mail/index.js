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
    ses: require("./ses")
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

// msg: { to, subject, text, html?, kind, recipientType, recipientId?, from?, alarmEventId?, ladderNote? }
async function send(msg)
{
    const driver = active();
    const notConfigured = driver.name === "none" && chosen().name !== "none";
    const id = await notifications.insert(
    {
        kind: msg.kind, channel: "email", recipient_type: msg.recipientType || "address", recipient_id: msg.recipientId || null,
        address: msg.to, alarm_event_id: msg.alarmEventId || null, ladder_note: msg.ladderNote || null,
        outcome: "failed", reason: "not attempted", provider: driver.name, subject: (msg.subject || "").slice(0, 200)
    });
    if (notConfigured)
    {
        await notifications.update(id, { outcome: "failed", reason: "mail driver " + chosen().name + " is not configured (Admin, Site settings, Email)" });
        return { ok: false, notificationId: id, reason: "mail driver not configured" };
    }
    try
    {
        const result = await driver.send({ to: msg.to, from: msg.from || fromAddress(), fromName: settings.get("MAIL_FROM_NAME", "") || settings.siteName(), subject: msg.subject, text: msg.text, html: msg.html || null });
        await notifications.update(id, { outcome: "sent", reason: null, provider_message_id: result.messageId });
        return { ok: true, notificationId: id };
    }
    catch (err)
    {
        // AWS SDK errors carry the SES error code in err.name (MessageRejected, AccessDeniedException, ...).
        const reason = ((err.name && err.name !== "Error" ? err.name + ": " : "") + (err.message || "send failed")).slice(0, 190);
        logger.error({ err: err.message, to: msg.to, driver: driver.name }, "mail send failed");
        await notifications.update(id, { outcome: "failed", reason: reason });
        return { ok: false, notificationId: id, reason: reason };
    }
}

module.exports = { send, active, chosen, drivers, fromAddress };
