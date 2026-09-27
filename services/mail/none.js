// Logs instead of sending. Active when MAIL_DRIVER=none or the chosen driver is not configured.
const logger = require("../../config/logger");

module.exports =
{
    name: "none",
    label: "None (log only)",
    settings: [],
    configured() { return true; },
    async send(msg)
    {
        // Full text goes to the log so reset, invite and alarm links are usable in dev.
        logger.warn({ to: msg.to, replyTo: msg.replyTo && msg.replyTo.length ? msg.replyTo : undefined, subject: msg.subject, text: msg.text }, "mail driver 'none': not sent");
        return { ok: true, messageId: null };
    }
};
