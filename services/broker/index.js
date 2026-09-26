// Which broker driver is in use. The choice is the BROKER_DRIVER site setting rather than an env
// key, so it can be switched without a deploy; an .env key of the same name still wins, as with
// every other setting. An unknown or blank value falls back to static, which manages nothing.
const settings = require("../../config/settings");

const drivers = { static: require("./static"), dynsec: require("./dynsec") };

function active()
{
    const name = String(settings.get("BROKER_DRIVER", "static") || "").trim();
    return drivers[name] || drivers.static;
}

module.exports = { active };
