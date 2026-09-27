# Voltastc: Mosquitto dynamic security and device provisioning

The broker and provisioning design, server side, as deployed on app.voltastc.com (Sep 26 2026).
The device side is `device-provisioning.md`; the reasons are also in `DECISIONS.md`. Verified on
Mosquitto 2.1.2 built from source and on the Ubuntu 26.04 package (2.0.22): 20 behaviour checks
(the app's server user, `announce`, the dynsec user, device users, command delivery, refusals, and a
session takeover that receives nothing) and a full provisioning run through nginx over HTTPS with
the device connecting on 8883.

## Goal

One MQTT user per device, confined to its own topic tree, created and removed by the server with
no broker restarts. No credential is ever delivered over a topic another device can hear.

## The rule that drives the design

On Mosquitto 2.0.x, dynsec permissions are scoped by **username only**: username -> role(s) -> ACLs,
where each ACL is an action, a topic filter (`+` and `#` allowed), and allow or deny. Nothing can be
scoped by client id, IP or connection, and `%u` / `%c` substitution does not exist before 2.1.0.
Everyone sharing a username has identical permissions, so a private topic needs a private username.
A shared bootstrap login that could receive credentials over MQTT cannot be made safe, which is why
credentials are delivered over HTTPS. On 2.1 the per device roles could collapse into one role using
`%u`; that is optional and not planned.

## Broker facts

- **Mosquitto 2.0.22, the Ubuntu 26.04 package** (universe), on the app server, updated by Ubuntu.
  The Mosquitto PPA builds 2.1.2 for 24.04 only, not 26.04. The app works the same on both.
- Configuration: Ubuntu's `/etc/mosquitto/mosquitto.conf` (persistence on in `/var/lib/mosquitto/`,
  log to `/var/log/mosquitto/mosquitto.log`, `include_dir /etc/mosquitto/conf.d`) plus
  `/etc/mosquitto/conf.d/voltastc.conf`, installed from `deploy/mosquitto/voltastc.conf`:
  `allow_anonymous false`, `plugin <dynsec .so>` (path found with `dpkg -L mosquitto`; on this arm64
  server `/usr/lib/aarch64-linux-gnu/mosquitto_dynamic_security.so`), `plugin_opt_config_file
  /var/lib/mosquitto/dynamic-security.json`, the two listeners. No `password_file`, no `acl_file`:
  dynsec is the only authentication source. `per_listener_settings` stays at its default (false),
  which makes `plugin` global.
- **2.0 versus 2.1:** 2.0 has no `global_plugin` and no `plugin_opt_password_init_file`, and never
  creates the dynsec file itself; the installer creates it with `mosquitto_ctrl dynsec init`
  (password fed twice on stdin, never on the command line). 2.1 generates the file on first start,
  including a `democlient` with full access and a plain text password file unless an init password
  is given, and logs a deprecation warning for `per_listener_settings`. The snippet as written works
  on both.
- **Plugin data** `/var/lib/mosquitto/dynamic-security.json`, owner `mosquitto`, mode 600. The broker
  rewrites the whole file (as `.new`, then a rename) on every client or role change. Back it up.
- **The broker drops privileges before it loads the plugin and the listener certificates**
  (2.0.22 `src/mosquitto.c`: `drop_privileges` then security init then listeners), so the dynsec
  file and the certificate copies must be readable by the `mosquitto` user. The plugin warns if its
  file is world readable or not owned by that user.
- **AppArmor.** Ubuntu 26.04's `apparmor` package ships a profile for mosquitto
  (`/etc/apparmor.d/mosquitto`) that allows only `mosquitto.db` in `/var/lib/mosquitto`. Without an
  addition the plugin logs "Error loading Dynamic security plugin config: File is not readable",
  the broker still starts, and every login is refused as "not authorised". The installer writes
  `/etc/apparmor.d/local/mosquitto` (the profile's supported include for site additions):
  `/var/lib/mosquitto/dynamic-security.json rwk,` and the same for `.new`, then runs
  `apparmor_parser -r`. Found on the first real install; a container test without AppArmor passed.
- Every change through the control API takes effect at once and survives restarts.

## Listeners

- `listener 1883 127.0.0.1`: plaintext, loopback only, for the app's own processes.
- `listener 8883`: TLS, all interfaces, for devices. Certificate and key are copies of the
  app.voltastc.com Let's Encrypt certificate in `/etc/mosquitto/certs/` (owner mosquitto, 0600),
  refreshed by the certbot deploy hook, which then sends SIGHUP; 2.0.22 reloads listener
  certificates on SIGHUP, so connected devices stay connected.
- EC2 security group: 8883 open, 1883 closed.

## Default ACL access (set by `scripts/broker-bootstrap.js`)

| Action | Default |
|---|---|
| publishClientSend | deny |
| publishClientReceive | **deny** (`mosquitto_ctrl dynsec init` and the 2.1 generated file both set allow) |
| subscribe | deny |
| unsubscribe | allow |

Why receive is deny: a client that connects with another client's id and clean session off
inherits that session's subscriptions with no username check (`src/handle_connect.c`, still true in
2.1.2), and every delivery is checked as `publishClientReceive`. With receive allowed by default,
any login could take over a persistent session and be delivered its traffic without subscribing.
Verified: a takeover by client id reuse receives nothing. **Every role must therefore carry a
`publishClientReceive` ACL matching what it subscribes to, or it subscribes and receives nothing.**

## Clients and roles

| Client | Role | Used by |
|---|---|---|
| `admin` | `admin` (2.0 init: full read, `$CONTROL/dynamic-security/#`, `$SYS`; on 2.1 `super-admin`) | People only. Password in `/etc/voltastc/broker.env`. |
| `voltastc_server` | `voltastc-server` | The ingest client and the web process's realtime relay (`MQTT_USER`), over 127.0.0.1:1883. |
| `voltastc_dynsec` | `dynsec-admin` | The app's dynsec driver: creates and removes device users (`MQTT_DYNSEC_USER`). |
| `announce` | `announce` | Shared first contact login, the same password in every firmware image. |
| `{guid}` | `dev-{guid}` | One per provisioned unit, created by the app. |

- `voltastc-server`: `subscribePattern` and `publishClientReceive` on `dev/+/#` and `acct/#`;
  `publishClientSend` on `dev/+/cmd/#`, `acct/#` and `con/endpoint`. Exactly what the code publishes
  and subscribes to; it cannot touch `$CONTROL`.
- `dynsec-admin`: `publishClientSend`, `publishClientReceive`, `subscribePattern` and
  `unsubscribePattern` on `$CONTROL/dynamic-security/#`. 2.1 generates this role; 2.0 does not, so
  the bootstrap creates it with the same ACLs (on 2.1 it just sets them again).
- `announce`: `subscribeLiteral` and `publishClientReceive` on `con/endpoint` only; no publish ACL.
  If its password is extracted from firmware it unlocks nothing but a public URL, and it cannot be
  used to spoof the endpoint.
- The 2.1 generated full access role `client` is deleted by the bootstrap when present.

`scripts/broker-bootstrap.js` sets all of this idempotently (create, or on "already exists"
modify), reads everything back and fails loudly on any difference, and with `--settings` stores the
MQTT site settings (`MQTT_HOST` 127.0.0.1, `MQTT_PORT` 1883, `MQTT_TLS` 0, `MQTT_USER`,
`MQTT_PASSWORD`, `MQTT_CLIENT_ID` voltastc-server, `BROKER_DRIVER` dynsec, `MQTT_DYNSEC_USER`,
`MQTT_DYNSEC_PASSWORD`, secrets encrypted). Passwords come from the environment
(`BROKER_ADMIN_PASSWORD`, `BROKER_SERVER_PASSWORD`, `BROKER_DYNSEC_PASSWORD`,
`BROKER_ANNOUNCE_PASSWORD`), which the installer loads from `/etc/voltastc/broker.env`.

## First contact: the retained endpoint

- Topic `con/endpoint` (`mqtt/topics.js`), retained, QoS 1, payload
  `{"url":"https://app.voltastc.com/provision/v1","published":"2026-09-26T23:13:15Z"}`. The date is
  for a human reading it with `mosquitto_sub`; firmware reads `url` and ignores the rest, so fields
  can be added without a firmware change.
- The path is the `PROVISION_PATH` setting (default `/provision/v1`); the host always comes from
  `APP_URL` (`mqtt/broker.provisionUrl()`), so the message always names this server.
- Published by the ingest process (`services/connectEndpoint.js`) on every ingest connect, which
  also covers an MQTT settings change, and once a day (`jobs/tasks/connectEndpoint.js`), so a stale
  date means ingest has not been running.
- Device: connect to 8883 as `announce`, subscribe to exactly `con/endpoint`, take the URL,
  disconnect, make the HTTPS call.

## Provisioning over HTTPS

1. The device POSTs `{ hw, model, fw }` to the URL. `model` is required and decides the device type
   through the `models` lists in the `deviceTypes` modules; a model no gateway or direct type lists
   is refused with 400. Every request updates `device_registry` (first and last firmware).
2. The server answers by what it holds for the MAC:
   - **nothing:** first contact. New unit GUID, broker account, `{ ok, guid, password }`.
   - **pending** (after Reprovision): a fresh password under the **same** GUID.
   - **active:** `{ ok, guid, existing: true }`. The device keeps its credentials.
3. The server claims the unit, creates the broker account, and only then activates the row and
   answers, so the device never holds a password for an account that does not exist. If the broker
   step fails the row returns to pending and the device gets a 500 and retries. Allow about 20 s.
4. The device connects to 8883 as `{guid}` and stays connected whether or not it is placed. Its
   data reaches its current placement; with none, the data is dropped quietly.
5. Placing, moving or removing it never touches its credentials.
6. If its MQTT login is refused (Reprovision, or the 30 day never-connected cleanup), firmware goes
   back to the announce step.

Status codes are real HTTP codes: 200 store or keep, 400 do not retry, 409 another attempt is
issuing so retry in seconds, 429 retry after `retry_after_secs`, 500 retry with backoff. Rate limit
per client IP (`PROVISION_RATE_PER_MINUTE`, default 10, in process). The client IP is the real one:
the app trusts only nginx on loopback, so a forged `X-Forwarded-For` cannot pick another bucket.
Every path under the mount answers JSON.

Optional, not adopted: a device generated random boot id stored in flash, sent with the POST and
pinned at first contact, so that knowing a MAC during a pending window would not be enough to obtain
credentials.

## Identity model

- **Unit:** one physical piece of hardware, keyed by **MAC**. Its `device_credentials` row holds the
  MQTT username (a GUID), the password and the state. It lives across placements and is revoked only
  by Reprovision or the never-connected cleanup. `device_registry` is its permanent birth record.
- **Placement:** a `devices` row, one stint of a unit at one location, owning sensors, history and
  alarms. Its uid is not a broker identity.
- **Current placement** is derived: the one live, unarchived device row with the unit's MAC as
  `hardware_id` (`ux_devices_hardware_id`). None means unclaimed.
- When a MAC appears somewhere new, a person chooses: archive the old placement and add a new one
  (history stays with the old one), or move the row (history travels). Credentials never change.

## Per device dynsec objects

Provision is one publish to `$CONTROL/dynamic-security/v1` with a `commands` array (`createRole`
then `createClient`), processed in order, one response message for the batch. The role
`dev-{guid}` holds exactly what `mqtt/topics.deviceAcls()` produces:

- `publishClientSend` on `dev/{guid}/frame`, `status`, `data`, `geoscan`, `cmd_ack` and
  `dev/{guid}/config/+`
- `subscribePattern` and `publishClientReceive` on `dev/{guid}/cmd/#`

Notes:

- Subscribe and receive are limited to `dev/{guid}/cmd/#` on purpose: MQTT 3.1.1 delivers a publish
  to every matching subscriber including the publisher, so a device subscribed to its whole tree
  would get its own data back. Everything the server sends a device goes under `dev/{guid}/cmd`.
- Remove is `deleteClient` then `deleteRole`; rotate is `setClientPassword`.
- `correlationData` is set per command and echoed in that command's reply. Replies go to every
  subscriber of the response topic at QoS 0, so correlation is mandatory and a reply can be lost.
- Idempotency, exact strings (same in 2.0.22 and 2.1.2): `Role already exists` then `modifyRole`
  (replaces the ACL set, so a stale role is repaired); `Client already exists` then
  `setClientPassword`; `Client not found` and `Role not found` on delete count as done.
- Every create reads the role back with `getRole` and throws if an ACL is missing; the daily audit
  (`jobs/tasks/brokerAudit.js`, one verbose `listRoles`) flags any role that drifts, on the device
  page.
- MQTT client id is `{model}-{mac}`, unique per unit and the same on every boot. It does not affect
  ACLs.
- Optional later hardening: bind the client id to the dynsec client (`setClientId`), so username,
  password and client id must all match.

## Who talks to dynsec

Any app process (`services/broker/dynsec.js`): the web process for provisioning, Reprovision and
delete, the ingest process for the audit and the cleanup. Each connects as `MQTT_DYNSEC_USER` with
client id `<MQTT_CLIENT_ID>-dynsec-<host>-<pid>` and a clean session, opened on first use, kept
open, reconnected by `mqtt/watch.js` when MQTT settings change. Subscribe to the response topic
before sending any command.

## Operating notes

- `mosquitto_ctrl` reads options from `$HOME/.config/mosquitto_ctrl` (source:
  `apps/mosquitto_ctrl/options.c`). For root, create `/root/.config/mosquitto_ctrl`, mode 600, with
  `-h 127.0.0.1`, `-u admin` and `-P <BROKER_ADMIN_PASSWORD>` on separate lines; then
  `sudo mosquitto_ctrl dynsec listClients`, `listRoles`, `getRole <name>` and
  `getDefaultACLAccess` work without prompts and without the password on the command line.
- Watch logins: `sudo tail -f /var/log/mosquitto/mosquitto.log` (each connect names the client id
  and the username).
- Instant rollback of the receive default if something goes quiet:
  `sudo mosquitto_ctrl dynsec setDefaultACLAccess publishClientReceive allow` (then find the role
  missing its receive ACL, and set it back to deny).
- Re-running `deploy/install.sh` re-applies the conf snippet, the AppArmor rule and the bootstrap;
  it never recreates `dynamic-security.json` once it exists, so device users survive.

## Open items

- **Certificate chain for firmware:** firmware pins ISRG Root X1 for both HTTPS and 8883. Check what
  a device actually receives before building firmware:
  `openssl s_client -connect app.voltastc.com:8883 -servername app.voltastc.com -showcerts </dev/null 2>/dev/null | grep -E " s:| i:"`
  (and the same on 443). Expect the leaf, the intermediate, and an issuer chaining to ISRG Root X1.
- **Model strings:** only `platform_server` exists today, so every provisioning request is refused
  with 400 until the pod types list their models.
