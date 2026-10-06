// SendGrid Web API v3 through @sendgrid/mail. One setting, SENDGRID_API_KEY (secret, encrypted in the
// settings table). The From address must be a verified single sender or on an authenticated domain.
const sgMail = require("@sendgrid/mail");
const settings = require("../../config/settings");

let configuredKey = null;

// Support request files (services/support.js): @sendgrid/helpers Attachment takes content as base64,
// filename, type and disposition.
function attachments(msg)
{
    if (!msg.attachments || !msg.attachments.length) { return undefined; }
    return msg.attachments.map((a) => ({ content: a.data.toString("base64"), filename: a.filename, type: a.contentType, disposition: "attachment" }));
}

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
        // @sendgrid/helpers takes one Reply-To in replyTo (a string) and several in replyToList ({ email } objects).
        const replyTo = [].concat(msg.replyTo || []);
        const [res] = await sgMail.send({ to: msg.to, from: msg.fromName ? { email: msg.from, name: msg.fromName } : msg.from, replyTo: replyTo.length === 1 ? replyTo[0] : undefined, replyToList: replyTo.length > 1 ? replyTo.map((a) => ({ email: a })) : undefined, subject: msg.subject, text: msg.text, html: msg.html || undefined, attachments: attachments(msg) });
        const id = res && res.headers ? res.headers["x-message-id"] : null;
        return { ok: true, messageId: id || null };
    }
};
