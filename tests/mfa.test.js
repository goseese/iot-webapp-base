const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
process.env.MQTT_HOST = process.env.MQTT_HOST || "localhost";
const mfa = require("../services/mfa");
const { nowEpoch } = require("../db/knex");

test("codes: 8 characters from the alphabet, shown as ABCD-EFGH", () =>
{
    for (let i = 0; i < 200; i++)
    {
        const c = mfa.generate();
        assert.equal(c.length, 8);
        for (const ch of c) { assert.ok(mfa.ALPHABET.includes(ch)); }
    }
    assert.equal(mfa.format("ABCDEFGH"), "ABCD-EFGH");
});

test("input is not case sensitive and ignores spaces and dashes", () =>
{
    const h = mfa.hash("ABCDEFGH");
    assert.ok(mfa.matches(h, "abcd-efgh"));
    assert.ok(mfa.matches(h, " ab cd-ef gh "));
    assert.ok(!mfa.matches(h, "ABCDEFGJ"));
    assert.ok(!mfa.matches(h, ""));
});

test("required: per user on and off override the site setting; .env 0 wins over on", () =>
{
    const saved = process.env.MFA_ENABLED;
    delete process.env.MFA_ENABLED;
    assert.equal(mfa.required({ mfa_mode: null }), false);   // site setting default off
    assert.equal(mfa.required({ mfa_mode: "on" }), true);
    assert.equal(mfa.required({ mfa_mode: "off" }), false);
    process.env.MFA_ENABLED = "1";
    assert.equal(mfa.required({ mfa_mode: null }), true);
    assert.equal(mfa.required({ mfa_mode: "off" }), false);
    process.env.MFA_ENABLED = "0";
    assert.equal(mfa.required({ mfa_mode: "on" }), false);
    if (saved === undefined) { delete process.env.MFA_ENABLED; } else { process.env.MFA_ENABLED = saved; }
});

test("channel is email unless sms is chosen, has a phone and is set up", () =>
{
    assert.equal(mfa.channelFor({ mfa_channel: "email", phone: "+15155551234" }), "email");
    assert.equal(mfa.channelFor({ mfa_channel: "sms", phone: "+15155551234" }), "email");   // SMS_DRIVER none
    assert.equal(mfa.maskEmail("jeff@example.com"), "j***@example.com");
    assert.equal(mfa.maskPhone("+1 (515) 555-1234"), "your phone ending in 1234");
});

function pendingWith(code, extra)
{
    const now = nowEpoch();
    return Object.assign({ userId: 1, hash: mfa.hash(code), expires: now + 600, attempts: 0, sentAt: now, resends: 0, channel: "email", sentTo: "j***@x.com", login: "jeff", returnTo: null }, extra || {});
}

test("check: ok, wrong with tries left, locked on the 5th wrong, expired", () =>
{
    let p = pendingWith("ABCDEFGH");
    assert.equal(mfa.check(p, "abcd-efgh").result, "ok");
    for (let i = 1; i <= 4; i++)
    {
        const r = mfa.check(p, "ZZZZZZZZ");
        assert.equal(r.result, "wrong");
        assert.equal(r.left, 5 - i);
        p = r.pending;
    }
    assert.equal(mfa.check(p, "ZZZZZZZZ").result, "locked");
    assert.equal(mfa.check(pendingWith("ABCDEFGH", { expires: nowEpoch() - 1 }), "ABCDEFGH").result, "expired");
});

test("resend: cooldown, cap and expiry are checked before any send", async () =>
{
    const r1 = await mfa.resend(pendingWith("ABCDEFGH"), {});
    assert.equal(r1.status, "cooldown");
    assert.ok(r1.seconds > 0 && r1.seconds <= 60);
    assert.equal((await mfa.resend(pendingWith("ABCDEFGH", { resends: 3, sentAt: nowEpoch() - 120 }), {})).status, "capped");
    assert.equal((await mfa.resend(pendingWith("ABCDEFGH", { expires: nowEpoch() - 1 }), {})).status, "expired");
});
