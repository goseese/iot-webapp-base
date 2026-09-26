// Shared magic link mechanics (architecture 4.2): random token, only its SHA-256 stored,
// single use, bound to purpose + subject, expiry from settings.
const crypto = require("crypto");
const tokens = require("../db/repos/tokens");
const { nowEpoch } = require("../db/knex");

function hashOf(token)
{
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function issue(purpose, subjectType, subjectId, ttlSecs, meta)
{
    const now = nowEpoch();
    await tokens.retire(purpose, subjectType, subjectId, now);
    const token = crypto.randomBytes(32).toString("base64url");
    await tokens.insert(
    {
        purpose: purpose,
        subject_type: subjectType,
        subject_id: subjectId,
        token_hash: hashOf(token),
        meta: meta ? JSON.stringify(meta) : null,
        expires_epoch: now + ttlSecs,
        created_epoch: now
    });
    return token;
}

// Consumes on success. Returns the row or null; never says why (enumeration safe).
async function consume(purpose, token)
{
    if (!token || token.length < 20) { return null; }
    const row = await tokens.findByHash(hashOf(token));
    const now = nowEpoch();
    if (!row || row.purpose !== purpose || row.used_epoch !== null || row.expires_epoch < now) { return null; }
    const claimed = await tokens.markUsed(row.id, now);
    if (claimed !== 1) { return null; }            // two clicks race; only one wins
    row.meta = row.meta ? JSON.parse(row.meta) : null;
    return row;
}

// Peek without consuming: for pages that render a form first and consume on submit.
async function peek(purpose, token)
{
    if (!token || token.length < 20) { return null; }
    const row = await tokens.findByHash(hashOf(token));
    if (!row || row.purpose !== purpose || row.used_epoch !== null || row.expires_epoch < nowEpoch()) { return null; }
    row.meta = row.meta ? JSON.parse(row.meta) : null;
    return row;
}

// Why a token is not usable, for the activity log only; never shown to the visitor.
// A retired token (a newer one was issued) is indistinguishable from a used one.
async function deadReason(purpose, token)
{
    if (!token || token.length < 20) { return "malformed"; }
    const row = await tokens.findByHash(hashOf(token));
    if (!row) { return "unknown"; }
    if (row.purpose !== purpose) { return "wrong purpose"; }
    if (row.used_epoch !== null) { return "used or replaced"; }
    if (row.expires_epoch < nowEpoch()) { return "expired"; }
    return "valid";
}

module.exports = { issue, consume, peek, deadReason };
