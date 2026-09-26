// Loads .env once and exposes a typed, validated config object.
// Anything that differs per environment lives here; operational knobs live in the settings table.
// dotenv's config() ignores DOTENV_CONFIG_PATH (only the dotenv/config preload reads it), so pass
// it through. Docker dev sets it to .env.local; without this every key missing there was filled
// from .env. Unset reads .env. Existing process env always wins.
require("dotenv").config({ path: process.env.DOTENV_CONFIG_PATH || undefined });

function str(name, fallback)
{
    const v = process.env[name];
    return (v === undefined || v === "") ? fallback : v;
}

function num(name, fallback)
{
    const v = process.env[name];
    if (v === undefined || v === "") { return fallback; }
    const n = Number(v);
    if (Number.isNaN(n)) { throw new Error("env " + name + " must be a number, got '" + v + "'"); }
    return n;
}

function bool(name, fallback)
{
    const v = process.env[name];
    if (v === undefined || v === "") { return fallback; }
    return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function required(name)
{
    const v = process.env[name];
    if (v === undefined || v === "") { throw new Error("env " + name + " is required (see .env.example)"); }
    return v;
}

const env =
{
    nodeEnv: str("NODE_ENV", "development"),
    isProd: str("NODE_ENV", "development") === "production",
    // web | ingest | all. pm2 may split web and ingest; docker dev runs everything in one process.
    role: str("ROLE", "all"),
    // Node listens on loopback only; nginx terminates TLS and proxies to it.
    host: str("HOST", "127.0.0.1"),
    port: num("PORT", 3000),
    appUrl: str("APP_URL", "http://localhost:3000"),
    autoMigrate: bool("AUTO_MIGRATE", true),

    sessionSecret: required("SESSION_SECRET"),
    settingsKey: required("SETTINGS_KEY"),

    db:
    {
        host: required("DB_HOST"),
        port: num("DB_PORT", 5432),
        name: required("DB_NAME"),
        user: required("DB_USER"),
        password: required("DB_PASSWORD"),
        // RDS for PostgreSQL 15+ forces SSL by default. The server certificate is verified
        // against the RDS CA bundle named by DB_SSL_CA. Local dev containers set DB_SSL=false.
        ssl: bool("DB_SSL", true),
        sslCa: str("DB_SSL_CA", "")
    },

    // MQTT broker settings live in site settings (Admin > Site settings > MQTT); see mqtt/broker.js.

    // Fallback from addresses only; the mail driver and its settings come from site settings
    // (an .env key of the same name still overrides through settings.get).
    mail:
    {
        supportFrom: str("SUPPORT_FROM_ADDRESS", ""),
        resetFrom: str("RESET_FROM_ADDRESS", "")
    },

    seed:
    {
        superadminUsername: str("SEED_SUPERADMIN_USERNAME", ""),
        superadminEmail: str("SEED_SUPERADMIN_EMAIL", ""),
        // Optional. Used only when the superadmin is first created; the account must still
        // set a real password at first login. Blank = random password printed to the log.
        superadminPassword: str("SEED_SUPERADMIN_PASSWORD", "")
    }
};

if (!["web", "ingest", "all"].includes(env.role))
{
    throw new Error("env ROLE must be web, ingest or all");
}

module.exports = env;
