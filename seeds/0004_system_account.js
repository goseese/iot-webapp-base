// The System account, its "server" location, and one platform_server device named after the
// site host. Server health readings land here through the normal pipeline.
const { knex, T, nowEpoch } = require("../db/knex");
const env = require("../config/env");
const accounts = require("../db/repos/accounts");
const locations = require("../db/repos/locations");
const devicesRepo = require("../db/repos/devices");
const tagsRepo = require("../db/repos/tags");
const deviceService = require("../services/devices");

const KNOWN_TAGS = ["dashboard", "dailyReport"];

async function run(log)
{
    let account = await accounts.findByName("System");
    if (!account)
    {
        const id = await accounts.insert({ name: "System", created_epoch: nowEpoch() });
        account = await accounts.findById(id);
        if (log) { log.info({}, "seeded System account"); }
    }
    for (const name of KNOWN_TAGS)
    {
        await tagsRepo.getOrCreate(account.id, name, true);
    }

    let location = await locations.findByAccountAndName(account.id, "server");
    if (!location)
    {
        const id = await locations.insert({ account_id: account.id, name: "server", iana_timezone: "UTC", created_epoch: nowEpoch() });
        location = await locations.findById(id);
        if (log) { log.info({}, "seeded server location"); }
    }

    // Identity is the hardware id (the site host), never the display name, which users may edit.
    const host = new URL(env.appUrl).hostname;
    let server = await devicesRepo.findLiveByHardwareId(host);
    if (!server)
    {
        // Adopt a platform_server device in this location that predates hardware ids.
        const orphan = (await devicesRepo.findByTypeSlug("platform_server")).find((d) => d.location_id === location.id && !d.hardware_id && !d.is_archived);
        if (orphan)
        {
            await knex(T("devices")).where({ id: orphan.id }).update({ hardware_id: host });
            server = orphan;
            if (log) { log.info({ name: orphan.name, hardware_id: host }, "adopted platform_server device"); }
        }
    }
    if (!server)
    {
        await deviceService.create({ locationId: location.id, typeSlug: "platform_server", name: host, hardwareId: host });
        if (log) { log.info({ hardware_id: host }, "seeded platform_server device"); }
    }
}

module.exports = { run };
