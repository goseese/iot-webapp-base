// Permission bits, defined once (architecture 4.3). Adding one is one line here; the grant
// editor renders from this list. Never renumber: bits are stored in grants.
const BITS =
[
    { name: "view",          bit: 1n << 0n,  label: "View",               description: "See locations, devices, sensors, charts and alarms." },
    { name: "edit",          bit: 1n << 1n,  label: "Edit",               description: "Rename and change settings on locations, devices and sensors." },
    { name: "add_device",    bit: 1n << 2n,  label: "Add devices",        description: "Add gateways and devices, accept joins, move devices in." },
    { name: "delete",        bit: 1n << 3n,  label: "Delete",             description: "Delete devices, sensors and locations." },
    { name: "ack_alarm",     bit: 1n << 4n,  label: "Acknowledge alarms", description: "Acknowledge or ignore active alarms." },
    { name: "clear_alarm",   bit: 1n << 5n,  label: "Clear alarms",       description: "Manually clear active alarms." },
    { name: "manage_alarms", bit: 1n << 6n,  label: "Manage alarm rules", description: "Create and edit alarm rules, schedules and alert groups." },
    { name: "set_offline",   bit: 1n << 7n,  label: "Set offline",        description: "Mark devices offline and back online." },
    { name: "lock_location", bit: 1n << 8n,  label: "Lock location",      description: "Change a location's membership mode." },
    { name: "manage_reports",bit: 1n << 9n,  label: "Manage reports",     description: "Create, edit and run reports." },
    { name: "api_write",     bit: 1n << 10n, label: "API write",          description: "Post readings and updates through the API." },
    { name: "grant",         bit: 1n << 11n, label: "Manage users",       description: "Invite users and edit grants, limited to bits the grantor holds." }
];

const byName = Object.fromEntries(BITS.map((b) => [b.name, b.bit]));
const ALL = BITS.reduce((acc, b) => acc | b.bit, 0n);

function bitsOf(names)
{
    return names.reduce((acc, n) =>
    {
        if (byName[n] === undefined) { throw new Error("unknown permission " + n); }
        return acc | byName[n];
    }, 0n);
}

// (effective & required) === required
function has(effective, required)
{
    return (BigInt(effective) & required) === required;
}

function names(bits)
{
    const b = BigInt(bits);
    return BITS.filter((p) => (b & p.bit) === p.bit).map((p) => p.name);
}

module.exports = { BITS, byName, ALL, bitsOf, has, names };
