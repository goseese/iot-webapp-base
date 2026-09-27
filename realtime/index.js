// Realtime for the web process (architecture 9, conventions section 9). The pipeline publishes
// once, to acct/{account_uid}/data; the web process subscribes to that account feed read only,
// enriches readings with display values, and relays to socket.io rooms per account. A user's
// socket joins the rooms of the accounts they can see, checked against the session on connect.
// start() attaches socket.io before the server listens; connectFeed() opens the broker feed
// after boot has loaded settings (the broker settings live there); reconnect() reopens it when
// those settings change (mqtt/watch.js).
const { Server } = require("socket.io");
const mqtt = require("mqtt");
const logger = require("../config/logger");
const { knex, T } = require("../db/knex");
const display = require("../services/display");
const metrics = require("../metrics");
const grants = require("../services/grants");
const users = require("../db/repos/users");
const broker = require("../mqtt/broker");

let io = null;
let feed = null;
const sensorCache = new Map();   // uid -> { at, sensor, location }

async function sensorByUid(uid)
{
    const hit = sensorCache.get(uid);
    if (hit && Date.now() - hit.at < 60000) { return hit; }
    const sensor = await knex(T("sensors")).where({ uid: uid }).first();
    const device = sensor ? await knex(T("devices")).where({ id: sensor.device_id }).first() : null;
    const location = device ? await knex(T("locations")).where({ id: device.location_id }).first() : null;
    const entry = { at: Date.now(), sensor: sensor, location: location };
    sensorCache.set(uid, entry);
    return entry;
}

function start(httpServer, sessionMiddleware)
{
    io = new Server(httpServer, { serveClient: true });
    io.engine.use(sessionMiddleware);

    io.on("connection", async (socket) =>
    {
        try
        {
            const sess = socket.request.session;
            const user = sess && sess.userId ? await users.findById(sess.userId) : null;
            if (!user || user.delete_epoch !== null) { socket.disconnect(true); return; }
            const ids = await grants.visibleAccountIds({ user: user });
            if (ids.length)
            {
                const rows = await knex(T("accounts")).whereIn("id", ids).select("uid");
                rows.forEach((r) => socket.join("acct:" + String(r.uid).toLowerCase()));
            }
            socket.emit("ready", { accounts: ids.length });
        }
        catch (err) { logger.warn({ err: err.message }, "socket auth failed"); socket.disconnect(true); }
    });

    // Admin > Event log live view (DECISIONS.md "Event log"): superadmins only, checked against the
    // session at the handshake, so anyone else is refused before joining. Rows arrive through
    // emitLog() from db/repos/events.js, for writes made in this process only (the ingest process
    // has no socket server; its rows show on the next page load).
    io.of("/admin-logs").use(async (socket, next) =>
    {
        try
        {
            const sess = socket.request.session;
            const user = sess && sess.userId ? await users.findById(sess.userId) : null;
            if (!user || user.delete_epoch !== null || !user.is_superadmin || user.must_set_password || sess.mustSetPassword) { return next(new Error("forbidden")); }
            next();
        }
        catch (err)
        {
            logger.warn({ err: err.message }, "admin-logs auth failed");
            next(new Error("forbidden"));
        }
    });
}

function emitLog(row)
{
    if (io) { io.of("/admin-logs").emit("log", row); }
}

function connectFeed()
{
    if (!io || feed) { return; }
    const cfg = broker.config();
    if (!cfg.configured)
    {
        logger.warn("mqtt not configured (MQTT_HOST is blank in site settings); realtime relay not connected");
        return;
    }
    const c = mqtt.connect(cfg.url, { clientId: cfg.clientId + "-web-" + require("os").hostname() + "-" + process.pid, username: cfg.user || undefined, password: cfg.password || undefined, clean: true, reconnectPeriod: 5000, rejectUnauthorized: true });
    feed = c;
    c.on("connect", () =>
    {
        c.subscribe(require("../mqtt/topics").ACCOUNT_PREFIX + "/+/data", { qos: 0 });
        c.subscribe(require("../mqtt/topics").ACCOUNT_PREFIX + "/+/config", { qos: 0 });
        logger.info({ url: cfg.url }, "realtime relay connected");
    });
    c.on("error", (err) => logger.warn({ err: err.message }, "realtime relay error"));
    c.on("message", async (topic, payload) =>
    {
        try
        {
            const accountUid = topic.split("/")[1];
            const msg = JSON.parse(payload.toString("utf8"));
            // Config notice: device uid only; the page fetches the rows itself (topics.account.config).
            if (topic.split("/")[2] === "config")
            {
                io.to("acct:" + accountUid).emit("config", { device: String(msg.device || "").toLowerCase() });
                return;
            }
            for (const r of msg.readings || [])
            {
                const e = await sensorByUid(r.sensor);
                r.display = e.sensor ? await display.format(e.sensor, r.value, e.location) : String(r.value);
                if (e.sensor)
                {
                    const unit = await display.resolveUnit(e.sensor, e.location);
                    r.unit = unit;
                    r.display_value = Number(metrics.fromCanonical(e.sensor.metric, r.value, unit).toFixed(4));
                }
            }
            io.to("acct:" + accountUid).emit("data", msg);
        }
        catch (err) { logger.warn({ err: err.message, topic: topic }, "relay message failed"); }
    });
}

function reconnect()
{
    if (!io) { return; }         // no web server in this process
    const old = feed;
    feed = null;
    if (!old)
    {
        connectFeed();
        return;
    }
    old.end(true, {}, () => connectFeed());
}

// The relay's broker connection, for mqtt/downlink.js: every web process has one, so a page action
// on any farm server can publish a command without going through the leader.
function feedClient() { return feed; }

module.exports = { start, connectFeed, reconnect, feedClient, emitLog };
