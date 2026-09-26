// Loads .env once and exposes a typed, validated config object.
// Anything that differs per environment lives here; operational knobs live in DTM_settings.
// dotenv's config() ignores DOTENV_CONFIG_PATH (only the dotenv/config preload reads it), so pass
// it through. Docker dev sets it to .env.local; without this every key missing there was filled
// from the production .env. Unset (IIS) reads .env as before. Existing process env always wins.
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
    // web | ingest | all. pm2 sets web/ingest on IIS; docker dev runs everything in one process.
    role: str("ROLE", "all"),
    // Kept as a string: under iisnode PORT is a Windows named pipe, not a TCP port.
    port: process.env.PORT || 3000,
    isIisnode: typeof process.env.PORT === "string" && process.env.PORT.startsWith("\\\\"),
    appUrl: str("APP_URL", "http://localhost:3000"),
    autoMigrate: bool("AUTO_MIGRATE", true),

    sessionSecret: required("SESSION_SECRET"),
    settingsKey: required("SETTINGS_KEY"),

    db:
    {
        host: required("DB_HOST"),
        port: num("DB_PORT", 1433),
        name: required("DB_NAME"),
        user: required("DB_USER"),
        password: required("DB_PASSWORD"),
        encrypt: bool("DB_ENCRYPT", true),
        trustCert: bool("DB_TRUST_CERT", true)
    },

    // MQTT broker settings live in site settings (Admin > Site settings > MQTT); see mqtt/broker.js.

    // Fallback from addresses only; the mail driver and its credentials come from site settings
    // (an .env key of the same name, e.g. SENDGRID_API_KEY, still overrides through settings.get).
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
