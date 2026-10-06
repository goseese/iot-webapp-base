// Generic SMTP through nodemailer: Amazon SES (SMTP endpoint), Bluehost, Dreamhost, Office 365,
// Google Workspace and most hosts. Transport rebuilt when any SMTP setting changes.
const nodemailer = require("nodemailer");
const settings = require("../../config/settings");

let transport = null;
let signature = null;

function current()
{
    return {
        host: settings.get("SMTP_HOST", ""),
        port: settings.get("SMTP_PORT", 587),
        secure: settings.get("SMTP_SECURE", false),
        user: settings.get("SMTP_USER", ""),
        pass: settings.get("SMTP_PASSWORD", "")
    };
}

module.exports =
{
    name: "smtp",
    label: "SMTP (SES, Bluehost, Dreamhost, Office 365, ...)",
    settings:
    [
        { key: "SMTP_HOST", kind: "string", description: "SMTP server host, e.g. email-smtp.us-east-1.amazonaws.com or mail.example.com." },
        { key: "SMTP_PORT", kind: "int", description: "SMTP port: 587 for STARTTLS, 465 for implicit TLS.", min: 1, max: 65535 },
        { key: "SMTP_SECURE", kind: "bool", description: "Implicit TLS on connect (port 465). Off = STARTTLS on 587." },
        { key: "SMTP_USER", kind: "string", description: "SMTP username (for SES, the SMTP credential user name, not the IAM key)." },
        { key: "SMTP_PASSWORD", kind: "secret", description: "SMTP password." }
    ],
    configured() { const c = current(); return !!(c.host && c.user && c.pass); },
    async send(msg)
    {
        const c = current();
        const sig = JSON.stringify(c);
        if (!transport || sig !== signature)
        {
            transport = nodemailer.createTransport({ host: c.host, port: Number(c.port) || 587, secure: !!c.secure, auth: { user: c.user, pass: c.pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
            signature = sig;
        }
        const info = await transport.sendMail({ from: msg.fromName ? { name: msg.fromName, address: msg.from } : msg.from, to: msg.to, replyTo: msg.replyTo && msg.replyTo.length ? [].concat(msg.replyTo) : undefined, subject: msg.subject, text: msg.text, html: msg.html || undefined });
        return { ok: true, messageId: info.messageId || null };
    }
};
