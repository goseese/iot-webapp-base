// A fake controller pod and target pods, for trying the station pages before firmware exists.
// Messages go through the real ingest code (pipeline/identify.js), the same path a controller's
// MQTT publishes take, so placement, sensors and the pairing rules behave as they will for real.
//
//   node scripts/fake-station.js connect <MAC>
//   node scripts/fake-station.js pair <MAC> on|off
//   node scripts/fake-station.js pods <MAC> <count> [--model vpod-acc|vpod-tof]
//   node scripts/fake-station.js ack <MAC> [--all] [--fail]
//   node scripts/fake-station.js band <MAC> <band id> [--rssi -40]
//   node scripts/fake-station.js button <MAC>
//   node scripts/fake-station.js progress <MAC> <pct>
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
// ack      answers the controller's command in flight (Commands tab, pod-protocol.md 5.2), the way
//          the controller would: ok for itself, and ok per target pod paired with it ("not_paired"
//          for any other MAC). --fail answers ok false (no_ack per target). --all keeps answering
//          until nothing is waiting.
// band     presents a wristband (12 hex digits) to the pod: at a controller it checks the band's
//          athlete in; at an account pod the page shows whose band it is, or offers to enroll it.
//          connect, ack and band also work for an Account pod added the same way.
// button   holds the controller's pairing button: the server grants pairing or refuses it (another
//          controller at the location is pairing); then "pair <MAC> on" plays the pod confirming.
// progress plays the controller's ota_progress events (pod-protocol.md 5.4) for the firmware update
//          in flight: <pct> for each pod it covers (the controller itself, one target pod, or all).
//          Then ack finishes it.
//
// The script opens a broker connection of its own when the MQTT site settings allow, so the next
// queued command goes out after an ack and open pages update by themselves. Without one, commands
// stay queued and pages need a refresh.
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
    console.log("  node scripts/fake-station.js ack <MAC> [--all] [--fail]");
    console.log("  node scripts/fake-station.js band <MAC> <band id> [--rssi -40]");
    console.log("  node scripts/fake-station.js button <MAC>");
    console.log("  node scripts/fake-station.js progress <MAC> <pct>");
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

// The pod placement holding this MAC (added in the app): a controller pod, or an account pod
// where anyPod allows it (connect, band, ack).
async function placement(ref, anyPod)
{
    const mac = normalize(ref);
    if (mac.length !== 12) { throw new Error("give the pod's 12 digit MAC"); }
    const device = await knex(T("devices")).where({ hardware_id: mac, is_archived: false }).whereNull("delete_epoch").first();
    if (!device) { throw new Error("no gateway with MAC " + mac + ". Add it in the app first: the location's Gateways page, Add gateway, type Controller pod (or Account pod)."); }
    const type = await knex(T("device_types")).where({ id: device.device_type_id }).first();
    const ok = type && (type.slug === "controller_pod" || (anyPod && type.slug === "account_pod"));
    if (!ok) { throw new Error(device.name + " is a " + (type ? type.display_name : "device") + ", not a " + (anyPod ? "Controller or Account pod" : "Controller pod") + "."); }
    device.type_slug = type.slug;
    return device;
}

// The pod and the GUID it "logs in" with, after connect.
async function findController(ref, anyPod)
{
    const device = await placement(ref, anyPod);
    const cred = await knex(T("device_credentials")).where({ mac: device.hardware_id, state: "active" }).whereNull("delete_epoch").first();
    if (!cred) { throw new Error(device.name + " has not connected yet. Run: node scripts/fake-station.js connect " + device.hardware_id); }
    return { device: device, guid: cred.broker_username };
}

async function connect(args)
{
    const device = await placement(args[0], true);
    const mac = device.hardware_id;
    const creds = await knex(T("device_credentials")).where({ mac: mac }).whereNull("delete_epoch");
    let guid;
    if (creds.length === 0)
    {
        guid = crypto.randomUUID();
        await knex(T("device_credentials")).insert({ device_id: device.id, mac: mac, state: "active", broker_username: guid, created_epoch: nowEpoch(), activated_epoch: nowEpoch(), type_slug: device.type_slug });
        if (device.type_slug === "controller_pod") { await send(guid, "config/pair_mode", "false"); }
        await send(guid, "config/report_secs", "600");
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
    // The connect message: the server sends a command left unanswered again, or the next queued one.
    await send(guid, "status", { event: "connect", firmware: "0.0.0-fake" });
    await controllerData(guid);

    console.log("  page: " + pageUrl(device));
    if (device.type_slug === "controller_pod")
    {
        console.log("Next:  click Pair target pods on the page, then");
        console.log("       node scripts/fake-station.js pair " + mac + " on");
        console.log("       node scripts/fake-station.js pods " + mac + " 5");
    }
    console.log("Wristband: node scripts/fake-station.js band " + mac + " C0FFEE000001");
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

// The controller's function button held (pod-protocol.md 6.3): the server grants pairing (pair_mode
// true) or refuses it (false). The real pod then confirms; here, "pair <MAC> on|off" plays that.
async function button(args)
{
    const { device, guid } = await findController(args[0]);
    await send(guid, "event", { event: "pair_request" });
    const st = await require("../services/stations").pairingState(device);
    const ev = await knex(T("event_log")).where({ event: "pair_request" }).whereRaw("details->>'entity_uid' = ?", [String(device.uid)]).orderBy("id", "desc").first();
    console.log(device.name + ": " + (ev ? ev.details.outcome + " (" + ev.details.detail + ")" : "no answer recorded") + ". pair_mode now pending " + st.pending + ".");
    if (st.pending === true) { console.log("The pod would now confirm: node scripts/fake-station.js pair " + device.hardware_id + " on"); }
}

// A wristband presented to the pod (pod-protocol.md section 8): check in at a controller, enroll
// at an account pod.
async function band(args)
{
    const { device, guid } = await findController(args[0], true);
    const id = normalize(args[1]);
    if (id.length !== 12) { throw new Error("give the band id: 12 hex digits, for example C0FFEE000001"); }
    const rssi = Number(option(args, "--rssi", -40));
    await send(guid, "event", { event: "band", band: id, rssi: rssi });
    const p = await knex(T("band_presentations")).where({ device_id: device.id }).orderBy("id", "desc").first();
    console.log("Band " + id + " presented to " + device.name + ": " + (p ? p.outcome : "not recorded") + ". " + pageUrl(device));
}

// Answers the command in flight like the controller would (pod-protocol.md 5.2).
async function ack(args)
{
    const { device, guid } = await findController(args[0], true);
    const fail = args.includes("--fail");
    const all = args.includes("--all");
    const queue = require("../services/commandQueue");
    let answered = 0;
    for (let i = 0; i < 50; i++)
    {
        let row = await knex(T("command_queue")).where({ device_id: device.id, status: "sent" }).orderBy("id").first();
        if (!row)
        {
            await queue.pump(device.id);      // queued but never sent (no broker connection at the time)
            row = await knex(T("command_queue")).where({ device_id: device.id, status: "sent" }).orderBy("id").first();
        }
        if (!row) { break; }
        const answer = { id: row.cmd_id, ok: !fail };
        if (row.target)
        {
            const paired = (await require("../services/stations").roster(device.id)).map((p) => p.hardware_id);
            const macs = row.target === "all" ? paired : [row.target];
            answer.results = {};
            for (const m of macs) { answer.results[m] = fail ? "no_ack" : (paired.includes(m) ? "ok" : "not_paired"); }
            answer.ok = !fail && Object.values(answer.results).every((r) => r === "ok");
        }
        if (fail) { answer.error = "fake failure"; }
        await send(guid, "cmd_ack", answer);
        answered++;
        console.log("Answered " + row.cmd + (row.value ? " " + row.value : "") + (row.target ? " to " + row.target : "") + ": " + (answer.ok ? "ok" : "failed") + (answer.results ? " " + JSON.stringify(answer.results) : ""));
        if (!all) { break; }
    }
    if (answered === 0)
    {
        const waiting = await knex(T("command_queue")).where({ device_id: device.id, status: "queued" }).count("id as n").first();
        console.log("Nothing is waiting for an answer from " + device.name + (Number(waiting.n) ? " (" + waiting.n + " queued, but no broker connection here to send them)" : "") + ".");
    }
    const left = await knex(T("command_queue")).where({ device_id: device.id }).whereIn("status", ["queued", "sent"]).count("id as n").first();
    console.log(left.n + " still waiting. Queue: " + pageUrl(device) + "/commands");
}

async function progress(args)
{
    const { device, guid } = await findController(args[0], true);
    const pct = Number(args[1]);
    if (!Number.isFinite(pct)) { throw new Error("give the percent, 0 to 100"); }
    const row = await knex(T("command_queue")).where({ device_id: device.id, cmd: "ota", status: "sent" }).orderBy("id").first();
    if (!row) { console.log("No firmware update is in flight at " + device.name + ". Queue one first (Commands or Station tab), or ack the command ahead of it."); return; }
    const macs = !row.target ? [device.hardware_id] : (row.target === "all" ? (await require("../services/stations").roster(device.id)).map((p) => p.hardware_id) : [row.target]);
    for (const m of macs) { await send(guid, "event", { event: "ota_progress", mac: m, pct: pct }); }
    console.log("Progress " + pct + "% for " + macs.join(", ") + ".");
}

// A broker connection for the queue and the page notices, with a client id of its own.
async function openBroker()
{
    const cfg = require("../mqtt/broker").config();
    if (!cfg.configured) { return null; }
    const c = require("mqtt").connect(cfg.url, { clientId: cfg.clientId + "-fake-station-" + process.pid, username: cfg.user || undefined, password: cfg.password || undefined, clean: true, reconnectPeriod: 0, connectTimeout: 5000 });
    await new Promise((resolve) =>
    {
        c.once("connect", resolve);
        c.once("error", resolve);
        c.once("close", resolve);
        setTimeout(resolve, 6000);
    });
    if (!c.connected) { c.end(true); return null; }
    require("../mqtt/downlink").useClient(c);
    return c;
}

async function main()
{
    const [cmd, ...args] = process.argv.slice(2);
    const run = { connect: connect, pair: pair, pods: pods, ack: ack, band: band, button: button, progress: progress }[cmd];
    if (!run) { usage(); process.exit(1); }
    await settings.reload();
    await require("../db/shadow").syncDeviceTypes();
    const broker = await openBroker();
    if (!broker) { console.log("(no broker connection: queued commands are not sent from here, and open pages need a refresh)"); }
    await run(args);
    if (broker) { await new Promise((resolve) => broker.end(false, {}, resolve)); }
    await knex.destroy();
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
