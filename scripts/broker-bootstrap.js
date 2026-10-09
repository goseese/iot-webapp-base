// Sets up the local Mosquitto dynamic security plugin for this app, then (with --settings) stores
// the MQTT site settings the app needs. Run by deploy/install.sh after the broker's first start;
// safe to run again: every step checks or repairs, nothing is duplicated.
//
// Verified against the mosquitto v2.1.2 source (plugins/dynamic-security, src/control_common.c) and
// run against 2.0.22, the Ubuntu 26.04 package that deploy/install.sh installs.
//
//   1. setDefaultACLAccess: publishClientReceive DENY. The generated first start config sets it to
//      allow, and 2.1.2 still lets a connection that reuses another client's id (clean start off)
//      inherit that session's subscriptions with no username check (src/handle_connect.c), so a
//      receive default of allow would leak other clients' traffic.
//   2. deleteRole "client": generated role with full # read/write, not used here.
//   3. Roles and clients:
//        <slug>_server    role <slug>-server    the app's ingest and realtime clients (MQTT_USER)
//        <slug>_dynsec    role dynsec-admin     creates and removes device users (MQTT_DYNSEC_USER)
//        announce         role announce         shared first contact login in every firmware image
//      dynsec-admin is created here with the same ACLs 2.1 generates for it (config_init.c
//      add_role_with_full_permission), because 2.0's `mosquitto_ctrl dynsec init` only creates an
//      "admin" role. The "admin" client (2.0: role admin, 2.1: super-admin) is left for people only.
//   4. Reads everything back and fails loudly if the broker does not hold what was asked for.
//
// Passwords come from the environment, never argv (argv is visible in ps):
//   BROKER_ADMIN_PASSWORD      the generated admin's password (plugin_opt_password_init_file)
//   BROKER_SERVER_PASSWORD     <slug>_server
//   BROKER_DYNSEC_PASSWORD     <slug>_dynsec
//   BROKER_ANNOUNCE_PASSWORD   announce (also goes into every firmware image)
// APP_SLUG, the site name slug, names the app's logins and role (deploy/install.sh passes it).
// Optional: BROKER_HOST (127.0.0.1), BROKER_PORT (1883), BROKER_ADMIN_USER (admin).
//
// node scripts/broker-bootstrap.js             broker only
// node scripts/broker-bootstrap.js --settings  broker, then Admin > Site settings > MQTT values
//                                              (needs .env and a migrated, seeded database)
const mqtt = require("mqtt");
const crypto = require("crypto");

const CONTROL_TOPIC = "$CONTROL/dynamic-security/v1";
const RESPONSE_TOPIC = CONTROL_TOPIC + "/response";
const TIMEOUT_MS = 10000;
const PRIORITY = 5;

const SLUG = process.env.APP_SLUG || "";
if (!/^[a-z][a-z0-9_]{0,31}$/.test(SLUG))
{
    console.error("APP_SLUG is required in the environment: lowercase letters, digits and _, starting with a letter");
    process.exit(1);
}
const SERVER_USER = SLUG + "_server";
const SERVER_ROLE = SLUG + "-server";
const SERVER_CLIENT_ID = SLUG + "-server";
const DYNSEC_USER = SLUG + "_dynsec";
const ANNOUNCE_USER = "announce";

const acl = (acltype, topic) => ({ acltype: acltype, topic: topic, priority: PRIORITY, allow: true });

// Exactly what the code publishes and subscribes to (mqtt/topics.js, realtime/index.js,
// pipeline/publish.js, mqtt/downlink.js, services/connectEndpoint.js). The dynsec control topic is
// only in dynsec-admin, the <slug>_dynsec client's role.
const ROLES =
[
    {
        rolename: SERVER_ROLE,
        acls:
        [
            acl("subscribePattern", "dev/+/#"),
            acl("publishClientReceive", "dev/+/#"),
            acl("subscribePattern", "acct/#"),
            acl("publishClientReceive", "acct/#"),
            acl("publishClientSend", "dev/+/cmd/#"),
            acl("publishClientSend", "acct/#"),
            acl("publishClientSend", "con/endpoint")
        ]
    },
    {
        rolename: "announce",
        acls:
        [
            acl("subscribeLiteral", "con/endpoint"),
            acl("publishClientReceive", "con/endpoint")
        ]
    },
    {
        rolename: "dynsec-admin",
        acls:
        [
            acl("publishClientSend", "$CONTROL/dynamic-security/#"),
            acl("publishClientReceive", "$CONTROL/dynamic-security/#"),
            acl("subscribePattern", "$CONTROL/dynamic-security/#"),
            acl("unsubscribePattern", "$CONTROL/dynamic-security/#")
        ]
    }
];

function required(name)
{
    const v = process.env[name];
    if (!v) { throw new Error(name + " is required in the environment"); }
    return v;
}

function connect(host, port, username, password)
{
    return new Promise((resolve, reject) =>
    {
        const c = mqtt.connect("mqtt://" + host + ":" + port,
        {
            clientId: SLUG + "-bootstrap-" + process.pid,
            username: username,
            password: password,
            clean: true,
            reconnectPeriod: 0,
            connectTimeout: 10000
        });
        c.once("connect", () =>
        {
            c.subscribe(RESPONSE_TOPIC, { qos: 0 }, (err) =>
            {
                if (err) { c.end(true); reject(err); return; }
                resolve(c);
            });
        });
        c.once("error", (err) => { c.end(true); reject(err); });
    });
}

// Sends one batch; resolves to one { ok, error, data } per command, in order.
function send(client, commands)
{
    return new Promise((resolve, reject) =>
    {
        const ids = commands.map(() => "bootstrap-" + crypto.randomBytes(6).toString("hex"));
        const results = new Array(commands.length).fill(null);
        const timer = setTimeout(() =>
        {
            client.removeListener("message", onMessage);
            reject(new Error("dynsec did not answer within " + TIMEOUT_MS + " ms"));
        }, TIMEOUT_MS);

        function onMessage(topic, payload)
        {
            if (topic !== RESPONSE_TOPIC) { return; }
            let msg = null;
            try { msg = JSON.parse(payload.toString("utf8")); }
            catch (err) { return; }
            for (const r of (msg && Array.isArray(msg.responses) ? msg.responses : []))
            {
                const i = ids.indexOf(r.correlationData);
                if (i >= 0) { results[i] = { ok: !r.error, error: r.error || null, data: r.data || null }; }
            }
            if (results.every((r) => r !== null))
            {
                clearTimeout(timer);
                client.removeListener("message", onMessage);
                resolve(results);
            }
        }

        client.on("message", onMessage);
        client.publish(CONTROL_TOPIC, JSON.stringify({ commands: commands.map((c, i) => Object.assign({}, c, { correlationData: ids[i] })) }), { qos: 1 });
    });
}

async function one(client, command)
{
    const [r] = await send(client, [command]);
    return r;
}

function fail(what, error)
{
    throw new Error(what + " failed: " + error);
}

async function ensureRole(client, role)
{
    const created = await one(client, { command: "createRole", rolename: role.rolename, acls: role.acls });
    if (created.ok) { return "created"; }
    if (created.error !== "Role already exists") { fail("createRole " + role.rolename, created.error); }
    const fixed = await one(client, { command: "modifyRole", rolename: role.rolename, acls: role.acls });
    if (!fixed.ok) { fail("modifyRole " + role.rolename, fixed.error); }
    return "updated";
}

async function ensureClient(client, username, password, rolename)
{
    const roles = [{ rolename: rolename, priority: PRIORITY }];
    const created = await one(client, { command: "createClient", username: username, password: password, roles: roles });
    if (created.ok) { return "created"; }
    if (created.error !== "Client already exists") { fail("createClient " + username, created.error); }
    const fixed = await one(client, { command: "modifyClient", username: username, password: password, roles: roles });
    if (!fixed.ok) { fail("modifyClient " + username, fixed.error); }
    return "updated";
}

async function verify(client)
{
    const problems = [];

    const def = await one(client, { command: "getDefaultACLAccess" });
    if (!def.ok) { fail("getDefaultACLAccess", def.error); }
    const receive = (def.data && Array.isArray(def.data.acls) ? def.data.acls : []).find((a) => a.acltype === "publishClientReceive");
    if (!receive || receive.allow !== false) { problems.push("default publishClientReceive is not deny"); }

    for (const role of ROLES)
    {
        const got = await one(client, { command: "getRole", rolename: role.rolename });
        if (!got.ok) { problems.push("role " + role.rolename + ": " + got.error); continue; }
        const have = new Set(((got.data && got.data.role && got.data.role.acls) || []).map((a) => a.acltype + " " + a.topic + " " + a.allow));
        for (const a of role.acls)
        {
            if (!have.has(a.acltype + " " + a.topic + " true")) { problems.push("role " + role.rolename + " missing " + a.acltype + " " + a.topic); }
        }
        if (have.size !== role.acls.length) { problems.push("role " + role.rolename + " has " + have.size + " ACLs, expected " + role.acls.length); }
    }

    for (const [username, rolename] of [[SERVER_USER, SERVER_ROLE], [DYNSEC_USER, "dynsec-admin"], [ANNOUNCE_USER, "announce"]])
    {
        const got = await one(client, { command: "getClient", username: username });
        if (!got.ok) { problems.push("client " + username + ": " + got.error); continue; }
        const roles = ((got.data && got.data.client && got.data.client.roles) || []).map((r) => r.rolename);
        if (roles.length !== 1 || roles[0] !== rolename) { problems.push("client " + username + " roles are [" + roles.join(", ") + "], expected [" + rolename + "]"); }
    }

    const client_ = await one(client, { command: "getRole", rolename: "client" });
    if (client_.ok) { problems.push("the generated full access role \"client\" still exists"); }

    return problems;
}

async function writeSettings(serverPassword, dynsecPassword)
{
    const settings = require("../config/settings");
    const { knex } = require("../db/knex");
    try
    {
        await settings.reload();
        const values =
        [
            ["MQTT_HOST", "127.0.0.1"],
            ["MQTT_PORT", "1883"],
            ["MQTT_TLS", "0"],
            ["MQTT_USER", SERVER_USER],
            ["MQTT_PASSWORD", serverPassword],
            ["MQTT_CLIENT_ID", SERVER_CLIENT_ID],
            ["BROKER_DRIVER", "dynsec"],
            ["MQTT_DYNSEC_USER", DYNSEC_USER],
            ["MQTT_DYNSEC_PASSWORD", dynsecPassword]
        ];
        for (const [k, v] of values)
        {
            await settings.set(k, v, null);
        }
        console.log("site settings: " + values.map((v) => v[0]).join(", ") + " stored (secrets encrypted)");
    }
    finally
    {
        await knex.destroy();
    }
}

async function main()
{
    const host = process.env.BROKER_HOST || "127.0.0.1";
    const port = Number(process.env.BROKER_PORT || 1883);
    const adminUser = process.env.BROKER_ADMIN_USER || "admin";
    const adminPassword = required("BROKER_ADMIN_PASSWORD");
    const serverPassword = required("BROKER_SERVER_PASSWORD");
    const dynsecPassword = required("BROKER_DYNSEC_PASSWORD");
    const announcePassword = required("BROKER_ANNOUNCE_PASSWORD");

    const client = await connect(host, port, adminUser, adminPassword);
    try
    {
        const def = await one(client,
        {
            command: "setDefaultACLAccess",
            acls:
            [
                { acltype: "publishClientSend", allow: false },
                { acltype: "publishClientReceive", allow: false },
                { acltype: "subscribe", allow: false },
                { acltype: "unsubscribe", allow: true }
            ]
        });
        if (!def.ok) { fail("setDefaultACLAccess", def.error); }
        console.log("default ACL access: send deny, receive deny, subscribe deny, unsubscribe allow");

        const del = await one(client, { command: "deleteRole", rolename: "client" });
        if (!del.ok && del.error !== "Role not found") { fail("deleteRole client", del.error); }
        console.log("role client: " + (del.ok ? "deleted" : "not present"));

        for (const role of ROLES)
        {
            console.log("role " + role.rolename + ": " + await ensureRole(client, role));
        }

        console.log("client " + SERVER_USER + ": " + await ensureClient(client, SERVER_USER, serverPassword, SERVER_ROLE));
        console.log("client " + DYNSEC_USER + ": " + await ensureClient(client, DYNSEC_USER, dynsecPassword, "dynsec-admin"));
        console.log("client " + ANNOUNCE_USER + ": " + await ensureClient(client, ANNOUNCE_USER, announcePassword, "announce"));

        const problems = await verify(client);
        if (problems.length > 0)
        {
            throw new Error("broker check failed:\n  " + problems.join("\n  "));
        }
        console.log("broker check: ok");
    }
    finally
    {
        client.end(true);
    }

    if (process.argv.includes("--settings"))
    {
        await writeSettings(serverPassword, dynsecPassword);
    }
}

main().catch((err) =>
{
    console.error(err.message);
    process.exit(1);
});
