// Daily check that the broker holds what the database says it should.
//
// For every UNIT holding a per unit broker account (migration 0020), placed or not, confirms its
// dev-{guid} role exists and carries every ACL mqtt/topics.deviceAcls produces, and records the
// result on the credential row. The device page shows it for placed units; the fault is on the unit,
// so it follows the hardware to its next placement.
//
// The failure this exists for does not report itself anywhere else: a role missing its
// publishClientReceive ACL lets the device connect, subscribe and be granted its QoS, and then every
// command sent to it is refused and dropped by the broker. The device looks healthy from every angle.
//
// Detect and record only. It does not repair: the fix is Reprovision on the device's Settings tab,
// which recreates the account through the same verified path as a first provision.
const { knex, T, nowEpoch } = require("../../db/knex");
const logger = require("../../config/logger");
const broker = require("../../services/broker");
const topics = require("../../mqtt/topics");

const FAULT_MAX = 300;          // NVARCHAR(300), migration 0019

// Plain language for the page, worst consequence first.
function describe(rolename, missingTypes)
{
    const consequence = missingTypes.includes("publishClientReceive")
        ? "The device can connect and publish, but it will never receive commands."
        : missingTypes.includes("subscribePattern")
            ? "Its command subscription is refused, so it will not receive commands."
            : "The broker refuses some of the data it sends.";
    return ("Broker role " + rolename + " is missing " + missingTypes.join(", ") + ". " + consequence).slice(0, FAULT_MAX);
}

async function run()
{
    const driver = broker.active();
    if (!driver.managesUsers || typeof driver.send !== "function") { return; }

    try { await driver.connect(); }
    catch (err)
    {
        logger.warn({ err: err.message }, "broker audit skipped; dynsec not reachable");
        return;
    }

    // One command returns every role with its full ACL list (roles.c add_role_to_json, verbose
    // branch; data.roles per roles.c:559), so this is a single round trip for any fleet size.
    const [listed] = await driver.send([{ command: "listRoles", verbose: true }]);
    if (!listed.ok)
    {
        logger.error({ err: listed.error }, "broker audit: listRoles failed");
        return;
    }
    const data = listed.response && listed.response.data ? listed.response.data : {};
    const roles = new Map();
    for (const role of Array.isArray(data.roles) ? data.roles : [])
    {
        if (!role || !role.rolename) { continue; }
        roles.set(role.rolename, new Set((Array.isArray(role.acls) ? role.acls : []).map((a) => a.acltype + " " + a.topic)));
    }

    // Units, not placements: no join to devices. The GUID is the unit's broker_username; a device
    // row uid is not the broker identity any more and device_id is NULL on new units. Only rows that
    // hold a password have a per unit account; static era rows use the shared credential.
    const rows = await knex(T("device_credentials"))
        .where("state", "active")
        .whereNull("delete_epoch")
        .whereNotNull("broker_password_enc")
        .select("id as cred_id", "broker_fault as fault", "broker_username as uid");

    const now = nowEpoch();
    let faults = 0;
    for (const r of rows)
    {
        const guid = String(r.uid).toLowerCase();
        const rolename = driver.roleFor(guid);
        const have = roles.get(rolename);
        let fault = null;
        if (!have)
        {
            fault = ("The broker has no role " + rolename + " for this device, so it can neither publish nor receive anything.").slice(0, FAULT_MAX);
        }
        else
        {
            const missing = topics.deviceAcls(guid).filter((a) => !have.has(a.acltype + " " + a.topic));
            if (missing.length > 0) { fault = describe(rolename, Array.from(new Set(missing.map((a) => a.acltype)))); }
        }

        await knex(T("device_credentials")).where({ id: r.cred_id }).update({ broker_fault: fault, broker_checked_epoch: now });
        if (fault)
        {
            faults++;
            logger.warn({ device: guid, fault: fault }, "broker audit fault");
        }
        else if (r.fault)
        {
            logger.info({ device: guid }, "broker audit fault cleared");
        }
    }
    logger.info({ checked: rows.length, faults: faults, roles: roles.size }, "broker audit complete");
}

module.exports = { run };
