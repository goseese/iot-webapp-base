// Bearer credentials for the HTTP API (architecture 4.3, 10). Key format <API_KEY_PREFIX>_<8 hex>_<secret>;
// only the SHA-256 of the whole key is stored, plus the visible start in key_prefix. Rate limit per credential from settings, in memory
// per web process (a burst limiter; pm2 runs one web process).
const crypto = require("crypto");
const settings = require("../config/settings");
const { knex, T, nowEpoch } = require("../db/knex");
const permissions = require("../permissions");

const buckets = new Map();   // credential id -> { minute, count }

function hashOf(key) { return crypto.createHash("sha256").update(key).digest("hex"); }

// URL unreserved characters only. The admin save route checks the same rule, but an .env value skips it.
const KEY_PREFIX_RE = /^[A-Za-z0-9._~-]{1,16}$/;

// The configured key prefix, or null when blank or invalid (no keys may be created then).
function keyPrefix()
{
    const p = String(settings.get("API_KEY_PREFIX", "") || "").trim();
    return KEY_PREFIX_RE.test(p) ? p : null;
}

function generate(prefixSetting)
{
    const prefix = prefixSetting + "_" + crypto.randomBytes(4).toString("hex");
    const secret = crypto.randomBytes(24).toString("base64url");
    const key = prefix + "_" + secret;
    return { key: key, prefix: prefix, hash: hashOf(key) };
}

async function authenticate(req, res, next)
{
    const h = req.get("authorization") || "";
    const key = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!key) { return res.status(401).json({ error: "Missing bearer token" }); }
    const cred = await knex(T("api_credentials")).where({ key_hash: hashOf(key) }).whereNull("delete_epoch").first();
    const now = nowEpoch();
    if (!cred || !cred.is_enabled || (cred.expires_epoch && cred.expires_epoch < now)) { return res.status(401).json({ error: "Invalid or expired token" }); }

    const limit = settings.get("API_RATE_PER_MINUTE", 120);
    const minute = Math.floor(now / 60);
    const b = buckets.get(cred.id) || { minute: minute, count: 0 };
    if (b.minute !== minute) { b.minute = minute; b.count = 0; }
    b.count++;
    buckets.set(cred.id, b);
    res.setHeader("x-ratelimit-limit", limit);
    res.setHeader("x-ratelimit-remaining", Math.max(0, limit - b.count));
    if (b.count > limit) { return res.status(429).json({ error: "Rate limit exceeded", retry_after_secs: 60 - (now % 60) }); }

    knex(T("api_credentials")).where({ id: cred.id }).update({ last_used_epoch: now }).catch(() => {});
    req.apiCredential = cred;
    req.apiGrants = await knex(T("grants")).where({ grantee_type: "api_credential", grantee_id: cred.id });
    next();
}

// Effective bits for a location: global credential (account_id NULL) = all bits everywhere.
function bitsAt(req, location)
{
    if (req.apiCredential.account_id === null) { return permissions.ALL; }
    if (location.account_id !== req.apiCredential.account_id) { return 0n; }
    return req.apiGrants.reduce((acc, g) =>
    {
        if (g.scope_type === "account" && g.scope_id === location.account_id) { return acc | BigInt(g.permission_bits); }
        if (g.scope_type === "location" && g.scope_id === location.id) { return acc | BigInt(g.permission_bits); }
        return acc;
    }, 0n);
}

async function visibleLocations(req)
{
    if (req.apiCredential.account_id === null) { return knex(T("locations")).whereNull("delete_epoch"); }
    const all = await knex(T("locations")).where({ account_id: req.apiCredential.account_id }).whereNull("delete_epoch");
    return all.filter((l) => permissions.has(bitsAt(req, l), permissions.byName.view));
}

module.exports = { generate, keyPrefix, KEY_PREFIX_RE, authenticate, bitsAt, visibleLocations, hashOf };
