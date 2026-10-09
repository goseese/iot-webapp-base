// Settings cache with resolution env -> settings table -> caller fallback.
// A key present in .env wins and is reported read only so the UI can grey it out.
// Secrets (kind = secret) are AES-256-GCM encrypted at rest with SETTINGS_KEY.
const crypto = require("crypto");
const env = require("./env");
const { knex, T, nowEpoch } = require("../db/knex");

const RELOAD_MS = 60 * 1000;
const key = Buffer.from(env.settingsKey, "hex");
if (key.length !== 32)
{
    throw new Error("SETTINGS_KEY must be 32 bytes hex (64 chars); generate with: openssl rand -hex 32");
}

let cache = new Map();
let loadedAt = 0;

function encrypt(plain)
{
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return "enc:" + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

function decrypt(stored)
{
    if (stored === null || stored === undefined || !String(stored).startsWith("enc:")) { return stored; }
    const buf = Buffer.from(String(stored).slice(4), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function coerce(kind, value)
{
    if (value === null || value === undefined) { return value; }
    if (kind === "int") { return Number(value); }
    if (kind === "bool") { return ["1", "true", "yes", "on"].includes(String(value).toLowerCase()); }
    return String(value);
}

async function reload()
{
    const rows = await knex(T("settings")).select("setting_key", "setting_value", "kind", "description", "min_value", "max_value", "needs_restart", "setting_group");
    const next = new Map();
    for (const r of rows)
    {
        const raw = r.kind === "secret" ? decrypt(r.setting_value) : r.setting_value;
        next.set(r.setting_key,
        {
            key: r.setting_key,
            kind: r.kind,
            value: coerce(r.kind, raw),
            description: r.description,
            min: r.min_value,
            max: r.max_value,
            needsRestart: !!r.needs_restart,
            group: r.setting_group || "general",
            fromEnv: process.env[r.setting_key] !== undefined && process.env[r.setting_key] !== ""
        });
    }
    cache = next;
    loadedAt = Date.now();
}

async function ensureFresh()
{
    if (Date.now() - loadedAt > RELOAD_MS) { await reload(); }
}

// Synchronous read from cache; boot calls reload() first so this is always populated.
function get(k, fallback)
{
    const fromEnv = process.env[k];
    const entry = cache.get(k);
    if (fromEnv !== undefined && fromEnv !== "") { return coerce(entry ? entry.kind : "string", fromEnv); }
    if (entry && entry.value !== null && entry.value !== undefined) { return entry.value; }
    return fallback;
}

function all()
{
    return Array.from(cache.values()).sort((a, b) => a.key.localeCompare(b.key));
}

async function set(k, value, userId)
{
    const entry = cache.get(k);
    if (!entry) { throw new Error("unknown setting " + k); }
    if (entry.fromEnv) { throw new Error(k + " is set in .env and cannot be changed here"); }
    const stored = entry.kind === "secret" ? encrypt(value) : String(value);
    await knex(T("settings")).where({ setting_key: k }).update(
    {
        setting_value: stored,
        updated_epoch: nowEpoch(),
        updated_by: userId || null
    });
    await reload();
}

// The one place the site name comes from: Admin > Site settings > General, SITE_NAME. Every page
// title, email, alert and report uses this; never hard code the name or its fallback elsewhere.
function siteName()
{
    return get("SITE_NAME", "") || "IoT Platform";
}

// The primary link color: Admin > Site settings > General, THEME_PRIMARY. null keeps the color in
// public/css/iot-theme.css. Only #RRGGBB passes, because the layouts write it into a style tag.
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function themePrimary()
{
    const v = String(get("THEME_PRIMARY", "") || "").trim();
    return COLOR_RE.test(v) ? v : null;
}

module.exports = { reload, ensureFresh, get, all, set, encrypt, decrypt, siteName, themePrimary, COLOR_RE };
