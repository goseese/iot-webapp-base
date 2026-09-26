// The unit's MQTT identity (migration 0020).
//
// A unit is one physical piece of hardware, keyed by MAC. Its credential row holds the broker
// username (a GUID, the one in dev/{guid}/... topics), the password and the state. It is NOT tied
// to a placement: go from a unit to its placement with currentPlacement(), and from a placement to
// its unit with forDevice(). Never join on device_credentials.device_id, which is only filled on
// rows written before the unit model and means nothing for new ones.
//
// Only MAC identified hardware has a credential. Direct devices identified by host name or IMEI do
// not, the same as before.
const { knex, T } = require("../knex");
const devicesRepo = require("./devices");

const MAC_RE = /^[0-9A-F]{12}$/;

// Live credential for a unit, by its normalized MAC (12 uppercase hex, no separators).
function forMac(mac)
{
    return knex(T("device_credentials")).where({ mac: mac }).whereNull("delete_epoch").first();
}

// Live credential by broker username. Stored lowercase, which is what mqtt/topics.parse returns,
// and indexed (ux_DTM_device_credentials_broker_username) because ingest calls this per message.
function forGuid(guid)
{
    return knex(T("device_credentials")).where({ broker_username: String(guid).toLowerCase() }).whereNull("delete_epoch").first();
}

// The unit behind a placement, linked by the placement's hardware id.
async function forDevice(device)
{
    if (!device || !MAC_RE.test(String(device.hardware_id || ""))) { return null; }
    return (await forMac(device.hardware_id)) || null;
}

// A unit's current placement: the one live, unarchived device row holding its MAC. The unique index
// ux_DTM_devices_hardware_id allows at most one. null means the unit is unclaimed: its credentials
// work and it can be sent commands, but its data has nowhere to go.
async function currentPlacement(mac)
{
    return (await devicesRepo.findLiveByHardwareId(mac)) || null;
}

// Hardware that holds its own broker credentials: a gateway or direct device identified by MAC.
function isUnitHardware(device)
{
    return !!device && (device.kind === "gateway" || device.kind === "direct") && MAC_RE.test(String(device.hardware_id || ""));
}

// "Waiting for first connection" for a placement: unit hardware whose unit holds no active
// credential yet. No row at all is now normal, since adding a device no longer creates one.
function awaiting(device, cred)
{
    return isUnitHardware(device) && (!cred || cred.state !== "active");
}

module.exports = { forMac, forGuid, forDevice, currentPlacement, isUnitHardware, awaiting };
