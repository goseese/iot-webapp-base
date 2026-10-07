// MFA sign in codes (DECISIONS.md "MFA sign in codes"). After a correct password a user who needs a
// code gets one by email (or SMS, hidden in this app), and the session holds only a pending sign in
// until the code passes. This module holds the rules; routes/auth.js holds the flow and the event
// log rows. Codes are never stored or logged readable: the session keeps their SHA-256 only.
const crypto = require("crypto");
const settings = require("../config/settings");
const mail = require("./mail");
const sms = require("./sms");
const notifications = require("../db/repos/notifications");
const { nowEpoch } = require("../db/knex");

// No 0, O, 1, I or L, which people misread.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECS = 60;
const MAX_RESENDS = 3;
// SMS is hidden in this app (DECISIONS.md "SMS is hidden, not removed"). The SMS path below works,
// but while this is false the profile never offers Text message, so every user stays on email.
// Turning SMS on later: set this true, add phone entry to the profile, set SMS_DRIVER.
const SMS_VISIBLE = false;

// MFA_ENABLED set in .env to a false value turns codes off for everyone, users set to On included:
// the way back in when mail is broken. settings.get() already lets .env win over the site setting,
// but not over a user's own On, so the override is read here. Same true values as config/settings.
function envOff()
{
    const v = process.env.MFA_ENABLED;
    if (v === undefined || v === "") { return false; }
    return !["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

// users.mfa_mode: NULL inherits the site setting, 'on' or 'off'.
function required(user)
{
    if (!user || envOff()) { return false; }
    if (user.mfa_mode === "on") { return true; }
    if (user.mfa_mode === "off") { return false; }
    return !!settings.get("MFA_ENABLED", false);
}

function codeMinutes()
{
    const n = Number(settings.get("MFA_CODE_MINUTES", 10));
    if (!Number.isInteger(n)) { return 10; }
    return Math.min(60, Math.max(2, n));
}

function generate()
{
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) { code += ALPHABET[crypto.randomInt(ALPHABET.length)]; }
    return code;
}

// ABCDEFGH shown as ABCD-EFGH.
function format(code)
{
    return code.slice(0, 4) + "-" + code.slice(4);
}

// Not case sensitive; spaces and dashes are ignored.
function normalize(input)
{
    return String(input || "").toUpperCase().replace(/[\s-]/g, "");
}

function hash(code)
{
    return crypto.createHash("sha256").update(normalize(code), "utf8").digest("hex");
}

// Both sides are SHA-256 hex, so the buffers are always 32 bytes and timingSafeEqual never throws.
function matches(storedHash, input)
{
    const a = Buffer.from(String(storedHash || ""), "hex");
    const b = Buffer.from(hash(input), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// SMS needs a driver other than none that has its settings. SMS_DRIVER stays none in this app
// (DECISIONS.md "SMS is hidden"), so this is false and every code goes by email.
function smsAvailable()
{
    const d = sms.active();
    return d.name !== "none" && d.configured();
}

// SMS only when the user chose it, has a phone number and SMS is set up; otherwise email.
function channelFor(user)
{
    return user.mfa_channel === "sms" && user.phone && smsAvailable() ? "sms" : "email";
}

// Where the code went, partly hidden, for the code modal.
function maskEmail(email)
{
    const s = String(email || "");
    const at = s.indexOf("@");
    if (at < 1) { return "your email"; }
    return s[0] + "***" + s.slice(at);
}

function maskPhone(phone)
{
    const digits = String(phone || "").replace(/\D/g, "");
    return "your phone ending in " + digits.slice(-4);
}

// The SMS notifications row keeps the message body (the email row does not), so the code in it is
// masked. Same row shape as the alarm SMS in services/alarms/notify.js.
async function sendSms(user, code, minutes)
{
    const driver = sms.active();
    const lines = (masked) => settings.siteName() + " sign in code: " + (masked ? "****-****" : format(code)) + "\nExpires in " + minutes + " minutes.";
    const nid = await notifications.insert({ kind: "mfa", channel: "sms", recipient_type: "user", recipient_id: user.id, address: user.phone, outcome: "failed", reason: "not attempted", provider: driver.name, subject: settings.siteName() + " sign in code", body: lines(true), sender: settings.get("TWILIO_FROM_NUMBER", "") || null });
    const result = await driver.send({ to: user.phone, text: lines(false) }).catch((err) => ({ ok: false, reason: err.message }));
    await notifications.update(nid, result.ok ? { outcome: "sent", reason: null, provider_message_id: result.messageId || null } : { outcome: "failed", reason: (result.reason || "send failed").slice(0, 200) });
    return result;
}

function sendEmail(user, code, minutes)
{
    return mail.send(
    {
        kind: "mfa", to: user.email, recipientType: "user", recipientId: user.id,
        subject: settings.siteName() + " sign in code",
        text: "Your sign in code is " + format(code) + ". It expires in " + minutes + " minutes. If you did not just try to sign in, change your password.\n"
    });
}

// Sends one code. A failed SMS falls back to email in the same call, so a bad number never locks
// anyone out. Returns { ok, channel, sentTo, smsFellBack, reason }.
async function deliver(user, code, minutes)
{
    let smsFellBack = false;
    let smsReason = null;
    if (channelFor(user) === "sms")
    {
        const r = await sendSms(user, code, minutes);
        if (r.ok) { return { ok: true, channel: "sms", sentTo: maskPhone(user.phone), smsFellBack: false, reason: null }; }
        smsFellBack = true;
        smsReason = r.reason || "send failed";
    }
    const e = await sendEmail(user, code, minutes);
    return {
        ok: !!e.ok, channel: "email", sentTo: maskEmail(user.email), smsFellBack: smsFellBack,
        reason: e.ok ? null : [smsReason ? "sms: " + smsReason : null, "email: " + (e.reason || "send failed")].filter(Boolean).join("; ")
    };
}

// First code after a correct password. login is the name as typed (the lockout counts failures by
// it); returnTo is read by the caller before anything regenerates the session.
// Returns { ok, sent, pending } where pending goes in req.session.mfa.
async function begin(user, login, returnTo)
{
    const code = generate();
    const minutes = codeMinutes();
    const sent = await deliver(user, code, minutes);
    if (!sent.ok) { return { ok: false, sent: sent, pending: null }; }
    const now = nowEpoch();
    return {
        ok: true, sent: sent,
        pending:
        {
            userId: user.id, hash: hash(code), expires: now + minutes * 60, attempts: 0,
            sentAt: now, resends: 0, channel: sent.channel, sentTo: sent.sentTo,
            login: login, returnTo: returnTo || null
        }
    };
}

// A new code. The old one is replaced only after the new one sends, and attempts carry over.
// Returns { status: sent | cooldown | capped | expired | failed, seconds?, sent?, pending? }.
async function resend(pending, user)
{
    const now = nowEpoch();
    if (now >= pending.expires) { return { status: "expired" }; }
    if (pending.resends >= MAX_RESENDS) { return { status: "capped" }; }
    const wait = pending.sentAt + RESEND_COOLDOWN_SECS - now;
    if (wait > 0) { return { status: "cooldown", seconds: wait }; }
    const code = generate();
    const minutes = codeMinutes();
    const sent = await deliver(user, code, minutes);
    if (!sent.ok) { return { status: "failed", sent: sent }; }
    return {
        status: "sent", sent: sent,
        pending: Object.assign({}, pending,
        {
            hash: hash(code), expires: now + minutes * 60, sentAt: now,
            resends: pending.resends + 1, channel: sent.channel, sentTo: sent.sentTo
        })
    };
}

// Returns { result: ok | wrong | expired | locked, left, pending } with pending carrying the new
// attempt count. An expired code is expired even when it matches.
function check(pending, input)
{
    if (nowEpoch() >= pending.expires) { return { result: "expired", left: 0, pending: pending }; }
    if (pending.attempts >= MAX_ATTEMPTS) { return { result: "locked", left: 0, pending: pending }; }
    if (matches(pending.hash, input)) { return { result: "ok", left: MAX_ATTEMPTS - pending.attempts, pending: pending }; }
    const next = Object.assign({}, pending, { attempts: pending.attempts + 1 });
    const left = MAX_ATTEMPTS - next.attempts;
    return { result: left <= 0 ? "locked" : "wrong", left: Math.max(0, left), pending: next };
}

module.exports =
{
    required, envOff, codeMinutes, generate, format, normalize, hash, matches,
    smsAvailable, channelFor, maskEmail, maskPhone, begin, resend, check,
    ALPHABET, CODE_LENGTH, MAX_ATTEMPTS, RESEND_COOLDOWN_SECS, MAX_RESENDS, SMS_VISIBLE
};
