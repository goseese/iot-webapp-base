const sgMail = require("@sendgrid/mail");
const settings = require("../../config/settings");

let configuredKey = null;

module.exports =
{
    name: "sendgrid",
    label: "SendGrid",
    settings:
    [
        { key: "SENDGRID_API_KEY", kind: "secret", description: "SendGrid API key with Mail Send permission." }
    ],
    configured() { return !!settings.get("SENDGRID_API_KEY", ""); },
    async send(msg)
    {
        const key = settings.get("SENDGRID_API_KEY", "");
        if (key !== configuredKey) { sgMail.setApiKey(key); configuredKey = key; }
        const [res] = await sgMail.send({ to: msg.to, from: msg.fromName ? { email: msg.from, name: msg.fromName } : msg.from, subject: msg.subject, text: msg.text, html: msg.html || undefined });
        const id = res && res.headers ? res.headers["x-message-id"] : null;
        return { ok: true, messageId: id || null };
    }
};
