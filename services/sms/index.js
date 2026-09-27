// SMS drivers: twilio (REST, no SDK) and none. Same contract as mail: the caller has already
// written the notifications row; this returns { ok, messageId, reason }.
const settings = require("../../config/settings");
const logger = require("../../config/logger");

const drivers =
{
    none: { name: "none", label: "None", settings: [], configured() { return true; }, async send() { return { ok: false, reason: "no sms driver configured" }; } },
    twilio:
    {
        name: "twilio",
        label: "Twilio",
        settings:
        [
            { key: "TWILIO_ACCOUNT_SID", kind: "secret", description: "Twilio account SID." },
            { key: "TWILIO_AUTH_TOKEN", kind: "secret", description: "Twilio auth token." },
            { key: "TWILIO_FROM_NUMBER", kind: "string", description: "Twilio sending number in E.164 form, e.g. +15155551234." }
        ],
        configured() { return !!(settings.get("TWILIO_ACCOUNT_SID", "") && settings.get("TWILIO_AUTH_TOKEN", "") && settings.get("TWILIO_FROM_NUMBER", "")); },
        async send(msg)
        {
            const sid = settings.get("TWILIO_ACCOUNT_SID", "");
            const token = settings.get("TWILIO_AUTH_TOKEN", "");
            const from = settings.get("TWILIO_FROM_NUMBER", "");
            if (!sid || !token || !from) { return { ok: false, reason: "twilio not configured" }; }
            const body = new URLSearchParams({ To: msg.to, From: from, Body: msg.text.slice(0, 1500) });
            const res = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json", { method: "POST", headers: { authorization: "Basic " + Buffer.from(sid + ":" + token).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, body: body });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) { logger.warn({ status: res.status, msg: json.message }, "twilio send failed"); return { ok: false, reason: (json.message || ("HTTP " + res.status)).slice(0, 190) }; }
            return { ok: true, messageId: json.sid || null };
        }
    }
};

function active()
{
    return drivers[settings.get("SMS_DRIVER", "none")] || drivers.none;
}

module.exports = { active, drivers };
