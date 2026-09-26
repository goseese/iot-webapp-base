// Adds a pending gateway from the terminal until the devices UI lands.
// node scripts/add-gateway.js <account name> <location name> <mac> <gateway name> [type slug]
const { knex } = require("../db/knex");
const accounts = require("../db/repos/accounts");
const locations = require("../db/repos/locations");
const deviceService = require("../services/devices");

(async () =>
{
    const [accountName, locationName, mac, name, typeSlug] = process.argv.slice(2);
    if (!accountName || !locationName || !mac || !name)
    {
        console.error("usage: node scripts/add-gateway.js <account> <location> <mac> <name> [type]");
        process.exit(1);
    }
    await require("../db/shadow").syncDeviceTypes();
    const account = await accounts.findByName(accountName);
    if (!account) { throw new Error("account not found: " + accountName); }
    const location = await locations.findByAccountAndName(account.id, locationName);
    if (!location) { throw new Error("location not found: " + locationName); }
    const device = await deviceService.create({ locationId: location.id, typeSlug: typeSlug || "gateway_generic", name: name, hardwareId: mac });
    console.log("gateway created, pending provisioning");
    console.log("  uid: " + String(device.uid).toLowerCase());
    console.log("  hardware id: " + device.hardware_id);
    await knex.destroy();
})().catch((err) => { console.error(err.message); process.exit(1); });
