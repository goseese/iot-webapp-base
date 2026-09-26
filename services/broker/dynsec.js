// Managed broker: one dynsec user and one role per device, created and removed by the server with
// no broker restarts (dynsec-broker-summary.md).
//
// Verified against the mosquitto 2.0.18 plugin source, which is the version deployed:
//
//  - A reply is {"responses":[{command, correlationData, error?, data?}]}. Success is the ABSENCE
//    of an "error" key, not a status field (plugin.c:230).
//  - send_response publishes with a NULL client (plugin.c:252), so EVERY subscriber of the response
//    topic sees EVERY admin's replies, including mosquitto_ctrl run by hand on the broker box.
//    correlationData is the only way to know which reply is ours; anything unrecognised is ignored.
//  - Responses go out at QoS 0, so a reply can be lost. Every command has a timeout and every
//    operation here is safe to run again.
//  - dynsec__handle_control (plugin.c:735) keeps going after a command fails, so a batch where
//    createRole is refused still processes createClient. Batching is safe.
//  - modifyRole replaces the ACL set, which is how a role created by an older build gets repaired.
//
// Any farm process may connect, each with its own client id (see connect), so provisioning,
// reprovision and delete work on whichever server took the request. Several admin connections at
// once are fine for the same reason mosquitto_ctrl is: replies are matched by correlationData.
const mqtt = require("mqtt");
const os = require("os");
const crypto = require("crypto");
const logger = require("../../config/logger");
const settings = require("../../config/settings");
const brokerCfg = require("../../mqtt/broker");

const CONTROL_TOPIC = "$CONTROL/dynamic-security/v1";
const RESPONSE_TOPIC = CONTROL_TOPIC + "/response";
const TIMEOUT_MS = 10000;

let client = null;
let ready = null;               // promise, resolved once subscribed to the response topic
const pending = new Map();      // correlationData -> { resolve, reject, timer, command }
let seq = 0;

// Carries the broker's own wording so callers can test for "Role already exists" and friends
// without string matching a generic Error message.
class DynsecError extends Error
{
    constructor(command, dynsecError)
    {
        super("dynsec " + command + ": " + dynsecError);
        this.name = "DynsecError";
        this.command = command;
        this.dynsecError = dynsecError;
    }
}

function roleFor(guid)
{
    return "dev-" + String(guid).toLowerCase();
}

function newPassword()
{
    return crypto.randomBytes(24).toString("base64url");
}

function onResponse(payload)
{
    let msg = null;
    try { msg = JSON.parse(payload.toString("utf8")); }
    catch (err) { logger.warn("dynsec response is not JSON"); return; }

    const list = msg && Array.isArray(msg.responses) ? msg.responses : [];
    for (const r of list)
    {
        const entry = r && r.correlationData ? pending.get(r.correlationData) : null;
        if (!entry) { continue; }       // someone else's command; not our business
        pending.delete(r.correlationData);
        clearTimeout(entry.timer);
        if (r.error) { entry.reject(new DynsecError(entry.command, r.error)); }
        else { entry.resolve(r); }
    }
}

function connect()
{
    if (ready) { return ready; }

    const cfg = brokerCfg.config();
    const user = String(settings.get("MQTT_DYNSEC_USER", "") || "").trim();
    const password = String(settings.get("MQTT_DYNSEC_PASSWORD", "") || "");
    if (!cfg.configured || user === "" || password === "")
    {
        return Promise.reject(new Error("dynsec is not configured; set MQTT_HOST, MQTT_DYNSEC_USER and MQTT_DYNSEC_PASSWORD"));
    }

    ready = new Promise((resolve, reject) =>
    {
        // Unique per process, the same pattern as the realtime relay (realtime/index.js). MQTT_CLIENT_ID
        // is identical on every farm member by design, so a shared id would let two processes evict
        // each other off the broker every few seconds. Host and pid make it unique; the clean session
        // below means the pid changing on every restart leaves no orphan session behind.
        const clientId = cfg.clientId + "-dynsec-" + os.hostname() + "-" + process.pid;
        const c = mqtt.connect(cfg.url,
        {
            clientId: clientId,
            username: user,
            password: password,
            clean: true,                 // control traffic; nothing to replay after a restart
            reconnectPeriod: 5000,
            connectTimeout: 15000,
            rejectUnauthorized: true
        });
        client = c;
        let settled = false;

        c.on("connect", () =>
        {
            // Subscribe before anything is sent, or the reply to the first command is missed.
            c.subscribe(RESPONSE_TOPIC, { qos: 0 }, (err) =>
            {
                if (err)
                {
                    logger.error({ err: err.message }, "dynsec response subscribe failed");
                    if (!settled) { settled = true; ready = null; c.end(true); reject(err); }
                    return;
                }
                logger.info({ url: cfg.url, clientId: clientId }, "dynsec admin connected");
                if (!settled) { settled = true; resolve(c); }
            });
        });
        c.on("message", (topic, payload) => onResponse(payload));
        c.on("reconnect", () => logger.warn("dynsec admin reconnecting"));
        c.on("error", (err) =>
        {
            logger.error({ err: err.message }, "dynsec admin error");
            // Only the first connection attempt reports failure to the caller. After that mqtt.js
            // retries on its own and in flight commands fail on their own timeouts.
            if (!settled) { settled = true; ready = null; c.end(true); reject(err); }
        });
    });
    return ready;
}

// Settings changed, or the leader is standing down.
function disconnect()
{
    const old = client;
    client = null;
    ready = null;
    for (const [id, entry] of pending)
    {
        clearTimeout(entry.timer);
        entry.reject(new Error("dynsec connection closed before " + entry.command + " answered"));
        pending.delete(id);
    }
    if (old) { old.end(true); }
}

function reconnect()
{
    if (!client && !ready) { return; }
    disconnect();
}

// Sends one batch and settles each command separately. Never rejects: the caller decides which
// errors are tolerable, and settling every command avoids stranding the rest of a batch when one
// of them fails.
async function send(commands)
{
    await connect();

    const entries = commands.map((cmd) =>
    {
        const id = "voltastc-" + Date.now().toString(36) + "-" + (++seq).toString(36) + "-" + crypto.randomBytes(4).toString("hex");
        return { id: id, command: cmd.command, body: Object.assign({}, cmd, { correlationData: id }) };
    });

    const waits = entries.map((e) => new Promise((resolve, reject) =>
    {
        const timer = setTimeout(() =>
        {
            pending.delete(e.id);
            reject(new Error("dynsec " + e.command + " timed out after " + TIMEOUT_MS + " ms"));
        }, TIMEOUT_MS);
        if (timer.unref) { timer.unref(); }
        pending.set(e.id, { resolve: resolve, reject: reject, timer: timer, command: e.command });
    }));

    client.publish(CONTROL_TOPIC, JSON.stringify({ commands: entries.map((e) => e.body) }), { qos: 1 });

    const settled = await Promise.allSettled(waits);
    return settled.map((s, i) => s.status === "fulfilled"
        ? { command: entries[i].command, ok: true, response: s.value, error: null }
        : { command: entries[i].command, ok: false, response: null, error: s.reason.dynsecError || s.reason.message });
}

// Treats one specific broker wording as success, and throws on anything else.
function tolerate(result, allowed)
{
    if (result.ok) { return false; }
    if (result.error === allowed) { return true; }
    throw new DynsecError(result.command, result.error);
}

// Reads the role back and confirms it carries every ACL type we asked for. The broker denies
// publishClientReceive by default, so a role missing its receive ACL lets a device subscribe
// successfully and then silently receive nothing. Nothing else in the system reports that.
async function verifyRole(rolename, acls)
{
    const [got] = await send([{ command: "getRole", rolename: rolename }]);
    if (!got.ok) { throw new DynsecError("getRole", got.error); }

    const role = got.response && got.response.data ? got.response.data.role : null;
    const have = new Set((role && Array.isArray(role.acls) ? role.acls : []).map((a) => a.acltype + " " + a.topic));
    const missing = acls.filter((a) => !have.has(a.acltype + " " + a.topic)).map((a) => a.acltype + " " + a.topic);
    if (missing.length > 0)
    {
        throw new Error("dynsec role " + rolename + " is missing ACLs after create: " + missing.join(", "));
    }
}

module.exports =
{
    name: "dynsec",
    managesUsers: true,

    // acls arrive already in dynsec shape from mqtt/topics.deviceAcls: { acltype, topic, priority, allow }.
    async createDeviceUser(guid, acls)
    {
        const username = String(guid).toLowerCase();
        const rolename = roleFor(username);
        const password = newPassword();

        const [role, client_] = await send(
        [
            { command: "createRole", rolename: rolename, acls: acls },
            { command: "createClient", username: username, password: password, roles: [{ rolename: rolename, priority: 5 }] }
        ]);

        // A role left over from an earlier life of this GUID may carry the wrong ACLs, so replace
        // the set rather than assuming it is right.
        if (tolerate(role, "Role already exists"))
        {
            const [fixed] = await send([{ command: "modifyRole", rolename: rolename, acls: acls }]);
            if (!fixed.ok) { throw new DynsecError("modifyRole", fixed.error); }
            logger.warn({ rolename: rolename }, "dynsec role already existed; ACLs replaced");
        }

        // Existing client: the password we just generated was not applied, so set it explicitly.
        if (tolerate(client_, "Client already exists"))
        {
            const [pw] = await send([{ command: "setClientPassword", username: username, password: password }]);
            if (!pw.ok) { throw new DynsecError("setClientPassword", pw.error); }
            logger.warn({ username: username }, "dynsec client already existed; password reset");
        }

        await verifyRole(rolename, acls);
        logger.info({ username: username, rolename: rolename }, "dynsec device user created");
        return { password: password };
    },

    async removeDeviceUser(guid)
    {
        const username = String(guid).toLowerCase();
        const rolename = roleFor(username);
        // Client first: deleting the role while the client still holds it would leave a login with
        // no permissions rather than no login.
        const [del, delRole] = await send(
        [
            { command: "deleteClient", username: username },
            { command: "deleteRole", rolename: rolename }
        ]);
        tolerate(del, "Client not found");
        tolerate(delRole, "Role not found");
        logger.info({ username: username, rolename: rolename }, "dynsec device user removed");
    },

    async rotateDeviceUser(guid)
    {
        const username = String(guid).toLowerCase();
        const password = newPassword();
        const [pw] = await send([{ command: "setClientPassword", username: username, password: password }]);
        if (!pw.ok) { throw new DynsecError("setClientPassword", pw.error); }
        logger.info({ username: username }, "dynsec device password rotated");
        return { password: password };
    },

    // Account level broker users are not part of this design; nothing calls these today.
    async createAccountUser() { return { password: null }; },
    async removeAccountUser() {},

    // For the driver's own use and for the audit job.
    roleFor: roleFor,
    send: send,
    connect: connect,
    disconnect: disconnect,
    reconnect: reconnect,
    DynsecError: DynsecError
};
