// A fake controller pod and target pods, for trying the station pages before firmware exists.
// Messages go through the real ingest code (pipeline/identify.js), the same path a controller's
// MQTT publishes take, so placement, sensors and the pairing rules behave as they will for real.
//
//   node scripts/fake-station.js connect <MAC>
//   node scripts/fake-station.js pair <MAC> on|off
//   node scripts/fake-station.js pods <MAC> <count> [--model vpod-acc|vpod-tof]
//
// First add the controller in the app: the location's Gateways page, Add gateway, type Controller
// pod, with the MAC. The page then says it is waiting for first connection.
// connect  plays that controller's first connection: an active credential row with no broker
//          account behind it, and the controller's first readings.
//          A made up MAC is simplest (for example 020000000101). With a real board's MAC, press
//          Reprovision on the controller's Settings tab before that board goes online, or it is
//          told it already has credentials and cannot log in.
// pair     plays the controller confirming pairing mode. Click "Pair target pods" on the page
//          first (the banner says STARTING), then run this with "on" and refresh.
// pods     sends one frame from each of <count> target pods (MACs 0A + the controller's last six
//          digits + a number), and new controller readings. While pairing is on, new pods pair;
//          with it off they are only recorded as heard. Run it again for new readings.
//
// No broker connection here, so open pages do not update by themselves: refresh after each step.
// The daily broker check flags the fake controller (it has no broker account); that is expected.
// Remove the fake pods with the reset-test-unit.js command that pods prints.
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
    console.log("  node scripts/fake-station.js connect <MAC>      (after Add gateway, type Controller pod, in the app)");
    console.log("  node scripts/fake-station.js pair <MAC> on|off");
    console.log("  node scripts/fake-station.js pods <MAC> <count> [--model vpod-acc|vpod-tof]");
}

function normalize(mac)
{
    return String(mac || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
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

// The controller placement holding this MAC (added in the app), checked to be a controller pod.
async function placement(ref)
{
    const mac = normalize(ref);
    if (mac.length !== 12) { throw new Error("give the controller's 12 digit MAC"); }
    const device = await knex(T("devices")).where({ hardware_id: mac, is_archived: false }).whereNull("delete_epoch").first();
    if (!device) { throw new Error("no gateway with MAC " + mac + ". Add it in the app first: the location's Gateways page, Add gateway, type Controller pod."); }
    const type = await knex(T("device_types")).where({ id: device.device_type_id }).first();
    if (!type || type.slug !== "controller_pod") { throw new Error(device.name + " is a " + (type ? type.display_name : "device") + ", not a Controller pod. Change its type or add another gateway."); }
    return device;
}

// The controller and the GUID it "logs in" with, after connect.
async function findController(ref)
{
    const device = await placement(ref);
    const cred = await knex(T("device_credentials")).where({ mac: device.hardware_id, state: "active" }).whereNull("delete_epoch").first();
    if (!cred) { throw new Error(device.name + " has not connected yet. Run: node scripts/fake-station.js connect " + device.hardware_id); }
    return { device: device, guid: cred.broker_username };
}

async function connect(args)
{
    const device = await placement(args[0]);
    const mac = device.hardware_id;
    const creds = await knex(T("device_credentials")).where({ mac: mac }).whereNull("delete_epoch");
    let guid;
    if (creds.length === 0)
    {
        guid = crypto.randomUUID();
        await knex(T("device_credentials")).insert({ device_id: device.id, mac: mac, state: "active", broker_username: guid, created_epoch: nowEpoch(), activated_epoch: nowEpoch(), type_slug: "controller_pod" });
        await send(guid, "config/pair_mode", "false");
        console.log(device.name + " connected (fake credentials, no broker account).");
    }
    else if (creds[0].state === "active")
    {
        guid = creds[0].broker_username;
        console.log(device.name + " was already connected; sent new readings.");
    }
    else
    {
        throw new Error(device.name + " has a credential row in state " + creds[0].state + ": a real unit has started provisioning with this MAC. Not faking over it.");
    }
    await controllerData(guid);

    console.log("  page: " + pageUrl(device));
    console.log("Next:  click Pair target pods on the page, then");
    console.log("       node scripts/fake-station.js pair " + mac + " on");
    console.log("       node scripts/fake-station.js pods " + mac + " 5");
    if (!["2", "6", "A", "E"].includes(mac.charAt(1)))
    {
        console.log("This looks like a real board's MAC. Before that board goes online, press Reprovision on the");
        console.log("controller's Settings tab, or the board is told it already has credentials and cannot log in.");
    }
    else
    {
        console.log("Remove: node scripts/reset-test-unit.js " + mac + " --yes");
    }
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
    const run = { connect: connect, pair: pair, pods: pods }[cmd];
    if (!run) { usage(); process.exit(1); }
    await settings.reload();
    await require("../db/shadow").syncDeviceTypes();
    await run(args);
    await knex.destroy();
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
