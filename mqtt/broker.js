// Broker connection settings for the ingest client and the realtime relay, read from site
// settings (an .env key of the same name still wins). Read at connect time; mqtt/watch.js
// reconnects both when the settings change, so no restart is needed.
const env = require("../config/env");
const settings = require("../config/settings");

// Same on every farm member so the leader's persistent session carries over on failover.
function defaultClientId()
{
    return "server-" + new URL(env.appUrl).hostname;
}

// Full URL of the HTTPS provisioning endpoint, for the retained con/endpoint message.
//
// Firmware is configured with the broker host only, so the web host has to come from this server's
// own APP_URL. Resolving the configured path against APP_URL, rather than gluing "https://" + host,
// keeps the scheme and port correct in every environment with no special casing: dev gets
// http://localhost:3000/provision/v1, production gets https://<domain>/provision/v1.
//
// The real default lives in seeds/0001_site_settings.js; the literal here only covers a database
// that predates that row. Note a leading-slash path replaces any path in APP_URL, so this assumes
// the app is served from the site root, which it is behind nginx.
function provisionUrl()
{
    let path = String(settings.get("PROVISION_PATH", "") || "").trim();
    if (path === "") { path = "/provision/v1"; }
    if (!path.startsWith("/")) { path = "/" + path; }
    return new URL(path, env.appUrl).toString();
}

function config()
{
    const host = String(settings.get("MQTT_HOST", "") || "").trim();
    const port = settings.get("MQTT_PORT", 1883);
    const tls = settings.get("MQTT_TLS", false);
    return {
        configured: host !== "",
        host: host,
        port: port,
        tls: tls,
        url: (tls ? "mqtts://" : "mqtt://") + host + ":" + port,
        user: settings.get("MQTT_USER", "") || "",
        password: settings.get("MQTT_PASSWORD", "") || "",
        clientId: String(settings.get("MQTT_CLIENT_ID", "") || "").trim() || defaultClientId()
    };
}

module.exports = { config, defaultClientId, provisionUrl };
