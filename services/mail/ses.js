// Amazon SES through the SESv2 API (SendEmail). No AWS keys are stored: the AWS SDK's default
// credential chain picks up the EC2 instance role (instance metadata) on the server, or a local
// ~/.aws profile in development. The role needs ses:SendEmail on Resource "*" (DECISIONS.md, "SES on
// the server": an identity/* resource is not enough when the account has a default configuration set).
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const settings = require("../../config/settings");

let client = null;
let clientRegion = null;

function region()
{
    return settings.get("SES_REGION", "");
}

// RFC 5322 From with an optional display name. SES needs a non-ASCII name as a MIME encoded-word.
function fromHeader(address, name)
{
    if (!name) { return address; }
    if (/^[\x20-\x7e]*$/.test(name))
    {
        return "\"" + name.replace(/["\\]/g, "\\$&") + "\" <" + address + ">";
    }
    return "=?UTF-8?B?" + Buffer.from(name, "utf8").toString("base64") + "?= <" + address + ">";
}

module.exports =
{
    name: "ses",
    label: "Amazon SES (API, EC2 instance role)",
    settings:
    [
        { key: "SES_REGION", kind: "string", description: "AWS region where the sending identity is verified, e.g. us-east-2." }
    ],
    configured() { return !!region(); },
    async send(msg)
    {
        const r = region();
        if (!client || r !== clientRegion)
        {
            client = new SESv2Client({ region: r });
            clientRegion = r;
        }
        const body = { Text: { Data: msg.text || "", Charset: "UTF-8" } };
        if (msg.html)
        {
            body.Html = { Data: msg.html, Charset: "UTF-8" };
        }
        const simple = { Subject: { Data: msg.subject || "", Charset: "UTF-8" }, Body: body };
        // Message.Attachments in the SESv2 SDK (models_0.d.ts); the SDK base64 encodes RawContent.
        // ContentTransferEncoding is how the part is written in the message: always BASE64. The API
        // documents no default, and without it a PNG arrived corrupted while a CSV came through
        // (chart email, Oct 2026): text survives 7 bit or quoted printable, binary does not.
        if (msg.attachments && msg.attachments.length)
        {
            simple.Attachments = msg.attachments.map((a) => (
            {
                RawContent: a.data,
                FileName: a.filename,
                ContentType: a.contentType,
                ContentDisposition: "ATTACHMENT",
                ContentTransferEncoding: "BASE64"
            }));
        }
        const res = await client.send(new SendEmailCommand(
        {
            FromEmailAddress: fromHeader(msg.from, msg.fromName),
            Destination: { ToAddresses: [].concat(msg.to) },
            ReplyToAddresses: msg.replyTo && msg.replyTo.length ? [].concat(msg.replyTo) : undefined,
            Content: { Simple: simple }
        }));
        return { ok: true, messageId: res.MessageId || null };
    }
};
