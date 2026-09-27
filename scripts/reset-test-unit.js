// Removes test units completely, so the same MAC can be run through first contact again.
//
//   node scripts/reset-test-unit.js <mac> [<mac> ...] [--yes] [--force] [--as <username>]
//
// Acts on the database in .env and the broker in its site settings: from this checkout, that is
// PRODUCTION. Without --yes it only prints what it would do.
//
// Per MAC, in this order:
//   1. deletes the unit's broker account (client <guid>, role dev-<guid>) through the dynsec driver.
//      "not found" counts as done. If the broker refuses or cannot be reached, the MAC is skipped
//      and nothing below runs, so a database row is never deleted while its account still exists.
//   2. soft deletes every live placement (device row) holding the MAC, through the same
//      deviceFlows.softDelete the UI uses, audited as --as (default SEED_SUPERADMIN_USERNAME).
//   3. hard deletes the unit's device_credentials rows, live and soft deleted.
//   4. hard deletes its device_registry row, so the next contact is a genuine first contact.
//
// Refuses any MAC that is not locally administered (second hex digit 2, 6, A or E) unless --force.
// Real hardware ships with universally administered MACs, so this keeps the script away from real
// units by default. Test with MACs like 020000000001.
//
// Step 4 overrides architecture 3.8 (the registry is never deleted), on purpose and only here: that
// rule protects the birth records of real hardware, and a made up test MAC has none worth keeping.
// If the database login is not allowed to DELETE from the registry, step 4 is refused and the
// script prints the statement to run as a login that is. (The app connects as the RDS master user
// today, which is allowed.)
const env = require("../config/env");
const settings = require("../config/settings");
const { knex, T } = require("../db/knex");

function normalize(mac)
{
    return String(mac || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

function locallyAdministered(mac)
{
    return ["2", "6", "A", "E"].includes(mac.charAt(1));
}

function usage()
{
    console.log("usage: node scripts/reset-test-unit.js <mac> [<mac> ...] [--yes] [--force] [--as <username>]");
    console.log("  without --yes: dry run, prints what would be removed");
    console.log("  --force: allow a MAC that is not locally administered (a real unit)");
    console.log("  --as: user recorded in the audit log for placement deletes (default " + (env.seed.superadminUsername || "none") + ")");
}

async function main()
{
    const args = process.argv.slice(2);
    const yes = args.includes("--yes");
    const force = args.includes("--force");
    const asAt = args.indexOf("--as");
    const asName = asAt >= 0 ? args[asAt + 1] : env.seed.superadminUsername;
    const macs = args.filter((a, i) => !a.startsWith("--") && !(asAt >= 0 && i === asAt + 1)).map(normalize);

    if (macs.length === 0) { usage(); process.exit(1); }
    for (const mac of macs)
    {
        if (mac.length !== 12) { throw new Error("not a 12 digit MAC: " + mac); }
        if (!force && !locallyAdministered(mac))
        {
            throw new Error(mac + " is not a locally administered MAC, so it may be real hardware. Pass --force only if you are sure.");
        }
    }

    await settings.reload();
    const actor = asName ? await knex(T("users")).where({ username: asName }).whereNull("delete_epoch").first() : null;
    if (!actor) { throw new Error("no user '" + asName + "' to record placement deletes as; pass --as <username>"); }

    const dynsec = require("../services/broker/dynsec");
    const deviceFlows = require("../services/deviceFlows");
    const dynsecReady = String(settings.get("MQTT_DYNSEC_USER", "") || "").trim() !== "" && String(settings.get("MQTT_DYNSEC_PASSWORD", "") || "") !== "";

    console.log((yes ? "RESETTING" : "DRY RUN, nothing changes without --yes") + ": database " + env.db.name + " on " + env.db.host);
    if (!dynsecReady) { console.log("dynsec credentials are not set in site settings: broker accounts cannot be removed, so any MAC that has one is skipped."); }

    for (const mac of macs)
    {
        const creds = await knex(T("device_credentials")).where({ mac: mac }).select("id", "broker_username", "state", "delete_epoch");
        const guids = Array.from(new Set(creds.map((c) => String(c.broker_username).toLowerCase())));
        const placements = await knex(T("devices")).where({ hardware_id: mac }).whereNull("delete_epoch");
        const reg = await knex(T("device_registry")).where({ mac: mac }).first();

        console.log("\n" + mac);
        console.log("  unit guids:       " + (guids.length ? guids.join(", ") : "none"));
        console.log("  credential rows:  " + creds.length + (creds.length ? " (" + creds.map((c) => c.state + (c.delete_epoch ? ", deleted" : "")).join("; ") + ")" : ""));
        console.log("  live placements:  " + (placements.length ? placements.map((p) => p.name + " [" + String(p.uid).toLowerCase() + "]" + (p.is_archived ? " archived" : "")).join("; ") : "none"));
        console.log("  registry row:     " + (reg ? "yes" : "no"));
        if (!yes) { continue; }

        // 1. Broker first. A DB row deleted while its account survives would be an orphan nobody can find.
        if (guids.length > 0)
        {
            if (!dynsecReady) { console.log("  SKIPPED: has broker accounts and dynsec is not configured"); continue; }
            let failed = false;
            for (const guid of guids)
            {
                try
                {
                    await dynsec.removeDeviceUser(guid);
                    console.log("  broker account removed (or was not there): " + guid);
                }
                catch (err)
                {
                    console.log("  SKIPPED: broker refused removing " + guid + ": " + err.message);
                    failed = true;
                }
            }
            if (failed) { continue; }
        }

        // 2. Placements, the same way the UI deletes them, so sensors, rules and alarms follow.
        for (const p of placements)
        {
            await deviceFlows.softDelete(p, actor);
            console.log("  placement soft deleted: " + p.name);
        }

        // 3. The unit.
        const n = await knex(T("device_credentials")).where({ mac: mac }).del();
        console.log("  credential rows deleted: " + n);

        // 4. The birth record (see the header on architecture 3.8).
        try
        {
            const r = await knex(T("device_registry")).where({ mac: mac }).del();
            console.log("  registry rows deleted: " + r);
        }
        catch (err)
        {
            console.log("  registry row NOT deleted: " + err.message);
            console.log("  run as an admin login:  DELETE FROM device_registry WHERE mac = '" + mac + "';");
        }
    }

    dynsec.disconnect();
    await knex.destroy();
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
