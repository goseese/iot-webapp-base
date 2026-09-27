// A fake controller pod and target pods, for trying the station pages before firmware exists.
// Messages go through the real ingest code (pipeline/identify.js), the same path a controller's
// MQTT publishes take, so placement, sensors and the pairing rules behave as they will for real.
//
//   node scripts/fake-station.js create [--location <location uid>] [--name "Fake station"]
//   node scripts/fake-station.js pair <controller uid or MAC> on|off
//   node scripts/fake-station.js pods <controller uid or MAC> <count> [--model vpod-acc|vpod-tof]
//
// create   adds a controller pod with a made up, locally administered MAC (02F5...) and an active
//          credential row with no broker account behind it. Without --location it lists locations.
// pair     plays the controller confirming pairing mode. Click "Pair target pods" on the page
//          first (the banner says STARTING), then run this with "on" and refresh.
// pods     sends one frame from each of <count> target pods (MACs 0A + the controller's last six
//          digits + a number), and new controller readings. While pairing is on, new pods pair;
//          with it off they are only recorded as heard. Run it again for new readings.
//
// No broker connection here, so open pages do not update by themselves: refresh after each step.
// The daily broker check flags the fake controller (it has no broker account); that is expected.
// Remove everything with the reset-test-unit.js command that create and pods print.
//
// Run on the server from /opt/voltastc as the app user, like the other scripts. Acts on the
// database in .env: from this checkout, that is PRODUCTION.
require("../config/logger").level = "error";   // ingest warns about the missing broker connection; not useful here
const crypto = require("crypto");
const env = require("../config/env");
const settings = require("../config/settings");
const { knex, T, nowEpoch } = require("../db/knex");

function usage()
{
    console.log("usage:");
    console.log("  node scripts/fake-station.js create [--location <location uid>] [--name \"Fake station\"]");
    console.log("  node scripts/fake-station.js pair <controller uid or MAC> on|off");
    console.log("  node scripts/fake-station.js pods <controller uid or MAC> <count> [--model vpod-acc|vpod-tof]");
}

function option(args, name, fallback)
{
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
}

function between(lo, hi, places)
{
    return Number((lo + Math.random() * (hi - lo)).toFixed(places));
}

function send(guid, channel, body)
{
    const payload = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return require("../pipeline/identify").handle("dev/" + guid + "/" + channel, payload);
}

function pageUrl(device)
{
    return env.appUrl.replace(/\/$/, "") + "/devices/" + String(device.uid).toLowerCase();
}

// The controller's own readings, so its page shows it online with values.
function controllerData(guid)
{
    return send(guid, "data",
    {
        vin: between(11.8, 12.4, 2), vbat: between(3.95, 4.15, 2), charge_state: 1,
        int_temp: between(22, 30, 1), int_hum: between(30, 50, 1),
        run_time: Math.floor(process.uptime()) + 3600, free_heap: 180000, wifi_rssi: Math.round(between(-70, -45, 0))
    });
}

// A controller by placement uid or MAC, with its credential (the fake GUID it "logs in" with).
async function findController(ref)
{
    const mac = String(ref || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    const q = knex(T("devices")).whereNull("delete_epoch");
    const device = /^[0-9a-f]{8}-/i.test(String(ref || "")) ? await q.where({ uid: String(ref).toLowerCase() }).first() : await q.where({ hardware_id: mac }).first();
    if (!device) { throw new Error("no controller " + ref); }
    const type = await knex(T("device_types")).where({ id: device.device_type_id }).first();
    if (!type || type.slug !== "controller_pod") { throw new Error(device.name + " is not a controller pod"); }
    const cred = await knex(T("device_credentials")).where({ mac: device.hardware_id, state: "active" }).whereNull("delete_epoch").first();
    if (!cred) { throw new Error(device.name + " has no active credential row"); }
    return { device: device, guid: cred.broker_username };
}

async function listLocations()
{
    const rows = await knex(T("locations") + " as l").join(T("accounts") + " as a", "a.id", "l.account_id")
        .whereNull("l.delete_epoch").select("a.name as account", "l.name", "l.uid").orderBy(["a.name", "l.name"]);
    console.log("Pass --location with one of these:");
    rows.forEach((r) => console.log("  " + String(r.uid).toLowerCase() + "  " + r.account + " / " + r.name));
}

async function create(args)
{
    const locUid = option(args, "--location", null);
    if (!locUid) { return listLocations(); }
    const location = await knex(T("locations")).where({ uid: String(locUid).toLowerCase() }).whereNull("delete_epoch").first();
    if (!location) { throw new Error("no location " + locUid); }

    // Next free fake MAC: 02F5 then 8 hex digits.
    let n = 1;
    let mac;
    for (;;)
    {
        mac = "02F5" + n.toString(16).toUpperCase().padStart(8, "0");
        const used = await knex(T("device_credentials")).where({ mac: mac }).first() || await knex(T("devices")).where({ hardware_id: mac }).whereNull("delete_epoch").first();
        if (!used) { break; }
        n++;
    }
    const name = option(args, "--name", "Fake station " + n);
    const device = await require("../services/devices").create({ locationId: location.id, typeSlug: "controller_pod", name: name, hardwareId: mac, model: "vpod-ctl", firmware: "0.0.0-fake" });
    const guid = crypto.randomUUID();
    await knex(T("device_credentials")).insert({ device_id: device.id, mac: mac, state: "active", broker_username: guid, created_epoch: nowEpoch(), activated_epoch: nowEpoch(), type_slug: "controller_pod" });
    await controllerData(guid);
    await send(guid, "config/pair_mode", "false");

    console.log("Created " + name + " in " + location.name);
    console.log("  MAC:  " + mac);
    console.log("  page: " + pageUrl(device));
    console.log("Next:  click Pair target pods on the page, then");
    console.log("       node scripts/fake-station.js pair " + mac + " on");
    console.log("       node scripts/fake-station.js pods " + mac + " 5");
    console.log("Remove: node scripts/reset-test-unit.js " + mac + " --yes");
}

async function pair(args)
{
    const { device, guid } = await findController(args[0]);
    const on = args[1] === "on";
    if (!on && args[1] !== "off") { usage(); process.exit(1); }
    await send(guid, "config/pair_mode", on ? "true" : "false");
    console.log(device.name + " now reports pairing " + (on ? "ON" : "OFF") + ". Refresh " + pageUrl(device));
}

async function pods(args)
{
    const { device, guid } = await findController(args[0]);
    const count = parseInt(args[1], 10);
    if (!(count >= 1 && count <= 30)) { throw new Error("count must be 1 to 30"); }
    const only = option(args, "--model", null);
    if (only && only !== "vpod-acc" && only !== "vpod-tof") { throw new Error("--model is vpod-acc or vpod-tof"); }

    // boot * 2^32 + seq comes out as the clock in ms, so it rises on every run and no frame is
    // dropped as a duplicate, however quickly the script is run again.
    const now = Date.now();
    const boot = Math.floor(now / 4294967296);
    const seq = now % 4294967296;
    const macs = [];
    for (let i = 1; i <= count; i++)
    {
        const mac = "0A" + device.hardware_id.slice(-6) + i.toString(16).toUpperCase().padStart(4, "0");
        macs.push(mac);
        await send(guid, "frame",
        {
            mac: mac, rssi: Math.round(between(-85, -45, 0)), model: only || (i % 3 === 0 ? "vpod-tof" : "vpod-acc"), fw: "0.0.0-fake",
            boot: boot, seq: seq,
            data: { vin: between(11.8, 12.4, 2), vbat: between(3.9, 4.15, 2), charge_state: i % 2, int_temp: between(20, 32, 1), int_hum: between(30, 55, 1), run_time: 3600 + i * 60, free_heap: 150000 }
        });
    }
    await controllerData(guid);

    const placed = await knex(T("devices")).whereIn("hardware_id", macs).whereNull("delete_epoch").where({ controller_id: device.id }).count("id as n").first();
    console.log("Sent " + count + " target pod frames through " + device.name + ": " + placed.n + " of them are paired with it.");
    if (Number(placed.n) < count) { console.log("The rest were only recorded as heard (pairing off here, or they are paired with another controller)."); }
    console.log("Refresh " + pageUrl(device));
    console.log("Remove the pods: node scripts/reset-test-unit.js " + macs.join(" ") + " --yes");
}

async function main()
{
    const [cmd, ...args] = process.argv.slice(2);
    const run = { create: create, pair: pair, pods: pods }[cmd];
    if (!run) { usage(); process.exit(1); }
    await settings.reload();
    await require("../db/shadow").syncDeviceTypes();
    await run(args);
    await knex.destroy();
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
