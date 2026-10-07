const { knex, T } = require("../db/knex");

// Site settings. Inserted only when the key is missing so admin edits are never overwritten.
// group: general | email | sms | mqtt | logging | api (tabs on the admin settings page)
const DEFAULTS =
[
    { key: "SITE_NAME", value: "Voltastc", kind: "string", group: "general", description: "Name shown in the sidebar, page titles and emails." },
    { key: "SESSION_HOURS", value: "168", kind: "int", group: "general", description: "Hours a login session stays valid without activity. Needs restart.", min: 1, max: 720 },
    { key: "PW_MIN_LENGTH", value: "10", kind: "int", group: "general", description: "Minimum password length.", min: 6, max: 128 },
    { key: "PW_REQUIRE_UPPER", value: "1", kind: "bool", group: "general", description: "Passwords must contain an upper case letter." },
    { key: "PW_REQUIRE_LOWER", value: "1", kind: "bool", group: "general", description: "Passwords must contain a lower case letter." },
    { key: "PW_REQUIRE_DIGIT", value: "1", kind: "bool", group: "general", description: "Passwords must contain a digit." },
    { key: "PW_REQUIRE_SYMBOL", value: "0", kind: "bool", group: "general", description: "Passwords must contain a symbol." },
    { key: "USERNAME_CHANGE_DAYS", value: "30", kind: "int", group: "general", description: "Days between username changes.", min: 0, max: 365 },
    { key: "RESET_LINK_MINUTES", value: "60", kind: "int", group: "general", description: "Minutes a password reset link stays valid.", min: 5, max: 1440 },
    { key: "INVITE_DAYS", value: "7", kind: "int", group: "general", description: "Days an invitation stays valid.", min: 1, max: 60 },
    { key: "LOGIN_MAX_FAILURES", value: "10", kind: "int", group: "general", description: "Failed logins per username or IP within the window before lockout.", min: 3, max: 100 },
    { key: "LOGIN_WINDOW_MINUTES", value: "15", kind: "int", group: "general", description: "Window for counting failed logins.", min: 1, max: 120 },
    { key: "MFA_ENABLED", value: "0", kind: "bool", group: "general", description: "Sign in codes: after the password, users get a one time code by email and must enter it. Per user On or Off on the account Users page (superadmins) overrides this. MFA_ENABLED=0 in .env turns codes off for everyone, including users set to On (the way back in when mail is broken)." },
    { key: "MFA_CODE_MINUTES", value: "10", kind: "int", group: "general", description: "Minutes a sign in code stays valid.", min: 2, max: 60 },
    { key: "RETENTION_DAYS_DEFAULT", value: "90", kind: "int", group: "logging", description: "Reading retention when a sensor and account both inherit.", min: 1, max: 3650 },
    { key: "COVERAGE_WINDOW_HOURS", value: "24", kind: "int", group: "general", description: "How recently a gateway must have heard a device to count for offline suppression.", min: 1, max: 168 },
    { key: "ONLINE_THRESHOLD_SECS", value: "900", kind: "int", group: "general", description: "Seconds since last contact before a gateway or device shows offline.", min: 60, max: 86400 },
    { key: "RENOTIFY_MINUTES", value: "60", kind: "int", group: "general", description: "Minutes between repeat notifications for an unacknowledged active alarm.", min: 5, max: 1440 },
    { key: "CHART_EMAIL_DAILY_LIMIT", value: "20", kind: "int", group: "general", description: "Chart emails one user may send from the site in 24 hours (Share > Email... > Send from the site). A user's own limit, when set, overrides this. 0 turns sending from the site off.", min: 0, max: 1000 },
    { key: "REPORT_FILE_DAYS", value: "30", kind: "int", group: "logging", description: "Days generated report files are kept.", min: 1, max: 365 },
    { key: "ALARM_TITLE_FORMAT", value: "{sensor_name} on {device_name} at {location_name}", kind: "string", group: "general", description: "Alarm title: the email subject after the event word, the first line of the SMS and the API alarm name. Overridden per account, location, device, sensor or alarm rule." },

    { key: "EVENT_LOG_DAYS", value: "30", kind: "int", group: "logging", description: "Days of event log kept (every request and the events it records).", min: 1, max: 365 },
    { key: "DEVICE_FRAMES_HOURS", value: "24", kind: "int", group: "logging", description: "Hours dedup frame claims are kept.", min: 1, max: 168 },
    { key: "RAW_PUBLISH_LOG_DAYS", value: "0", kind: "int", group: "logging", description: "Days of raw MQTT payloads kept for parser debugging. 0 = off.", min: 0, max: 30 },
    { key: "PURGE_BATCH_ROWS", value: "2000", kind: "int", group: "logging", description: "Rows deleted per purge batch.", min: 100, max: 20000 },

    { key: "API_RATE_PER_MINUTE", value: "120", kind: "int", group: "api", description: "API requests per minute per credential.", min: 10, max: 10000 },
    { key: "API_MAX_OBJECTS", value: "1000", kind: "int", group: "api", description: "Maximum reading objects per API post.", min: 1, max: 10000 },
    { key: "API_KEY_PREFIX", value: "voltastc", kind: "string", group: "api", description: "Prefix for new API keys, 1 to 16 characters from A-Z a-z 0-9 - . _ ~. Existing keys are not changed." },

    { key: "MAIL_DRIVER", value: "none", kind: "string", group: "email", description: "Outbound mail driver." },
    { key: "MAIL_FROM_ADDRESS", value: null, kind: "string", group: "email", description: "From address for every email the platform sends. Must be a verified sender at the provider." },
    { key: "MAIL_FROM_NAME", value: null, kind: "string", group: "email", description: "From name; blank uses the site name." },
    { key: "SUPPORT_EMAILS", value: null, kind: "string", group: "email", description: "The site support team: addresses separated by commas, semicolons or spaces. They get every new support request and every reply as one message with all of them in To and Reply-To set to this list, separate from the account's own support handlers. Blank: requests are still saved, this list gets no email." },
    { key: "SUPPORT_FROM_ADDRESS", value: null, kind: "string", group: "email", description: "Sender on every support email, so mail rules can match on it. One address or blank (blank uses the From address above). Must be a verified sender, or on a verified domain, at the mail provider; check with a test request." },
    { key: "SMS_DRIVER", value: "none", kind: "string", group: "sms", description: "Outbound SMS driver." },

        { key: "MQTT_HOST", value: null, kind: "string", group: "mqtt", description: "Applies within 15 seconds." },
    { key: "MQTT_PORT", value: "1883", kind: "int", group: "mqtt", description: "Broker port (8883 TLS, 1883 plain). Applies within 15 seconds.", min: 1, max: 65535 },
    { key: "MQTT_TLS", value: "0", kind: "bool", group: "mqtt", description: "Connect with TLS (mqtts). Applies within 15 seconds." },
    { key: "MQTT_USER", value: null, kind: "string", group: "mqtt", description: "Broker username. Applies within 15 seconds." },
    { key: "MQTT_PASSWORD", value: null, kind: "secret", group: "mqtt", description: "Broker password. Applies within 15 seconds." },
    { key: "MQTT_CLIENT_ID", value: null, kind: "string", group: "mqtt", description: "Ingest client id. One per environment, the same on every farm server, never used by any other broker client. Applies within 15 seconds." },

    // Device provisioning over HTTPS. In the mqtt group because mqtt/watch.js polls that group's
    // updated_epoch every 15 s, which is what republishes the retained con/endpoint message.
    { key: "PROVISION_PATH", value: "/provision/v1", kind: "string", group: "mqtt", description: "Path of the HTTPS provisioning endpoint. Published in the retained con/endpoint message, with the host taken from APP_URL. Applies within 15 seconds." },
    { key: "PROVISION_RATE_PER_MINUTE", value: "10", kind: "int", group: "mqtt", description: "Provisioning requests per minute per IP address before the endpoint refuses. Applies within 15 seconds.", min: 1, max: 1000 },

    // Broker driver and the dynsec admin login it uses. Only the leader connects as this user.
    { key: "BROKER_DRIVER", value: "static", kind: "string", group: "mqtt", description: "How per device broker accounts are managed: static (one shared credential, no accounts created) or dynsec (a user and role per device). An unknown value falls back to static. Applies within 15 seconds." },
    { key: "MQTT_DYNSEC_USER", value: null, kind: "string", group: "mqtt", description: "Broker user for the dynamic security control API, used by the leader only. Needs the built in admin role. Applies within 15 seconds." },
    { key: "MQTT_DYNSEC_PASSWORD", value: null, kind: "secret", group: "mqtt", description: "Password for the dynamic security admin user. Applies within 15 seconds." },
];

// Every driver declares the settings it needs; they land in the driver's group.
function driverSettings()
{
    const out = [];
    const mail = require("../services/mail").drivers;
    for (const d of Object.values(mail)) { for (const s of d.settings || []) { out.push(Object.assign({ group: "email", value: null }, s)); } }
    const sms = require("../services/sms").drivers;
    for (const d of Object.values(sms)) { for (const s of d.settings || []) { out.push(Object.assign({ group: "sms", value: null }, s)); } }
    return out;
}

async function run(log)
{
    for (const s of DEFAULTS.concat(driverSettings()))
    {
        const existing = await knex(T("settings")).where({ setting_key: s.key }).first();
        if (existing)
        {
            // Group, description and bounds are owned by code; the value is the admin's.
            await knex(T("settings")).where({ id: existing.id }).update({ setting_group: s.group, description: s.description, min_value: s.min === undefined ? null : s.min, max_value: s.max === undefined ? null : s.max, needs_restart: /Needs restart/.test(s.description) ? 1 : 0 });
            continue;
        }
        await knex(T("settings")).insert(
        {
            setting_key: s.key,
            setting_value: s.value === undefined ? null : s.value,
            kind: s.kind,
            description: s.description,
            setting_group: s.group,
            min_value: s.min === undefined ? null : s.min,
            max_value: s.max === undefined ? null : s.max,
            needs_restart: /Needs restart/.test(s.description) ? 1 : 0
        });
        if (log) { log.info({ key: s.key }, "seeded setting"); }
    }
}

module.exports = { run };
