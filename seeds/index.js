// Ordered, idempotent seeds. Device types must be shadowed first because the System seed
// creates a device.
const shadow = require("../db/shadow");

const list =
[
    require("./0001_site_settings"),
    require("./0002_known_lists"),
    require("./0003_superadmin"),
    require("./0004_system_account"),
    require("./0005_default_alert_groups")
];

async function run(log)
{
    await shadow.syncDeviceTypes(log);
    for (const seed of list)
    {
        await seed.run(log);
    }
}

module.exports = { run };
