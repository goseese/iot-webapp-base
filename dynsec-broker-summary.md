# devmon: Mosquitto dynamic security and device provisioning

Summary of decisions and the broker state as configured (updated 2026-09-20). Broker host: `it-ubuntu-iot`, public name `iot.datatelematics.io`. Companion to `leader-lock-summary.md`. The broker side is complete and tested. The Node side is complete (Sep 2026): settings, retained endpoint, unauthenticated endpoint, the dynsec driver, per unit identity with synchronous issuing, a daily audit and a never-connected cleanup. Switched on with the `BROKER_DRIVER` site setting. Verified against the live broker on 2026-09-21 with `scripts/provision-test.sh` and a throwaway MAC: first contact issued a unit GUID and password, the role passed its `getRole` read-back, the device logged in and subscribed to `dev/{guid}/cmd/#`, a repeat request returned `existing`, and a server publish to `dev/{guid}/cmd` was delivered, proving the receive ACL. Firmware is not written. This version replaces all earlier copies.

## Goal

One MQTT user per device (gateway, device, asset: same table, different types), confined to its own topic tree, created and removed by the server with no broker restarts. No credential is ever delivered over a topic another device can hear.

## The rule that drives the design

On Mosquitto 2.0.x, dynsec permissions are scoped by **username only**: username -> role(s) -> ACLs, where each ACL is an action, a literal topic (`+` and `#` allowed), and allow or deny. Nothing can be scoped by client id, IP, or connection, and `%u` / `%c` substitution does not exist until 2.1.0 (verified in `plugins/dynamic-security/acl.c` at tags v2.0.18 and v2.0.22). Everyone sharing a username has identical permissions, so a private topic requires a private username. A shared bootstrap login that can receive credentials over MQTT cannot be made safe on this broker, which is why credentials are delivered over HTTPS.

## Broker facts

- Mosquitto 2.0.18 on Ubuntu 22.04, from the official mosquitto PPA. The PPA offers 2.0.22 for 22.04 (patch release, optional; notable fix in 2.0.21 for a leak triggerable by an authenticated client). Mosquitto 2.1.x is packaged only for 24.04. Decision: no upgrade for this work. 2.1 would arrive with a future OS upgrade (22.04 standard support ends April 2027) and would only allow collapsing the per device roles into one shared role.
- Plugin: `/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so`
- Plugin data: `/var/lib/mosquitto/dynamic-security.json` (owner `mosquitto`, mode 600). The broker rewrites the whole file on every client/role change. Add it to the backup set.
- `per_listener_settings` unset (default `false`). `password_file` commented out: dynsec is the only auth source. Do not add an `acl_file` alongside dynsec. Rollback copy of the pre dynsec config: `/etc/mosquitto/mosquitto.conf.bak`.
- `persistence true`, so retained messages survive broker restarts.

## Listeners

- `listener 1883 127.0.0.1`: plaintext, loopback only, for the local Node processes on the broker box.
- `listener 8883`: TLS, all interfaces. Everything remote, including IT-WebApp01/02 and all field devices.
- TLS files are copies of the Let's Encrypt cert in `/etc/mosquitto/ca_certificates/`. Current cert: CN `iot.datatelematics.io`, issuer Let's Encrypt YR2, expires 2026-11-22.
- `allow_anonymous false`.

## dynsec default ACL access (changed from the init defaults)

| Action | Default |
|---|---|
| publishClientSend | deny |
| publishClientReceive | **deny** (was allow) |
| subscribe | deny |
| unsubscribe | allow |

Why receive is deny: in 2.0.18 a client that connects with another client's id and clean session off inherits that session's subscriptions with no username check (`src/handle_connect.c`), and every delivery is checked as `publishClientReceive` (`src/subs.c`). With receive defaulting to allow, any login could take over a persistent session and be delivered its traffic without ever subscribing. With receive denied by default, a role receives only what it explicitly lists. **Every role must therefore carry a `publishClientReceive` ACL matching what it subscribes to, or it will subscribe successfully and receive nothing.**

## dynsec clients

| Client | Role | Used by |
|---|---|---|
| `dynsec_admin` | `admin` (built in) | Plugin administration only. Its role already includes receive ACLs. Cannot publish to normal topics. |
| `devmon_server` | `legacy_full` | The devmon app on IT-WebApp01/02 (leader ingest plus the per process `-web-` relays), over 8883. |
| `server_admin` | `legacy_full` | Three older local Node processes on the broker box, over loopback 1883. |
| `device` | `legacy_full` | Legacy shared credential. Used by `gw7080-7c4fad842518` (firmware update pending), a dev only gateway, and possibly the legacy `/dom/...` field devices (see open items). |
| `announce` | `announce` | Shared first contact login, same in every firmware image. Can only read `con/endpoint`. |

## dynsec roles

- `admin`: built in.
- `legacy_full`: send `#`, subscribe `#`, receive `#`. Reproduces the old password file behavior. To be tightened later.
- `announce`: subscribeLiteral `con/endpoint`, publishClientReceive `con/endpoint`. No publish ACL, so it cannot publish anywhere. Tested: receives the retained URL, is refused on `con/#`, and its publish to `con/endpoint` is denied.
- `dev-{guid}`: one per provisioned device, created by the server (below).
- The earlier shared `dev` role (with `%u`) has been deleted.

## First contact: retained endpoint

The web app and the broker can be on different hosts (here the IIS farm and `iot.datatelematics.io`), so firmware is configured with the broker host only and learns the rest.

- Topic `con/endpoint` (`mqtt/topics.js`, `connect.endpoint`), retained, QoS 1, payload
  `{"url":"https://<web host>/provision/v1","published":"2026-09-21T01:20:45Z"}`. The `published` date
  is there for a human reading the message with `mosquitto_sub`, to tell at a glance whether it is
  current or left over from weeks ago. Firmware reads `url` and ignores the rest, so a field can be
  added later without a firmware change.
- **Not under `/api/v1`.** `routes/api.js` applies bearer auth to that entire router, so a device on
  first contact, which by definition holds no API key, is refused by that middleware before any
  handler runs. Provisioning is its own unauthenticated router, `routes/provision.js`, mounted at
  `/provision/v1` ahead of the API router and therefore also ahead of session and CSRF.
- The path is the site setting `PROVISION_PATH` (Admin > Site settings > MQTT, default
  `/provision/v1`). The host is deliberately not configurable: `mqtt/broker.provisionUrl()` resolves
  the path against `APP_URL`, so the published message always carries this server's own name, scheme
  and port, and dev and production need no special casing.
- Only the server publishes it, and only the leader (`services/connectEndpoint.js`): on every ingest
  connect, which also covers an MQTT settings change because `mqtt/watch.js` turns one into a
  reconnect, and once a day from `jobs/tasks/connectEndpoint.js` so that a stale date means no leader
  has been running rather than only that nobody restarted the app.
- Device: connect to 8883 as `announce`, subscribe to exactly `con/endpoint`, receive the URL at once, disconnect, make the HTTPS call.
- If the `announce` password is extracted from firmware it unlocks nothing but a public URL, and it cannot be used to spoof the endpoint.

## Provisioning over HTTPS

Replaces the platform flow in architecture reference 7.3 (changed Sep 2026, see DECISIONS.md "Broker identity belongs to the unit"). Identity belongs to the physical unit, keyed by MAC, not to a placement. The device side, with retry and failure handling, is in `device-provisioning.md`.

1. Device POSTs `{ hw, model, fw }` to the provisioning URL. `model` is required and decides the device type through the `models` lists in the `deviceTypes` modules; a model no gateway or direct type lists is refused with 400. Every request updates `device_registry`, including first and last firmware.
2. The server answers by what it holds for the MAC:
   - **nothing:** first contact. New unit GUID, broker account, `{ guid, password }`. No human step and no placement needed.
   - **pending** (after Reprovision, or lost flash): a fresh password under the **same** GUID.
   - **active:** `{ existing: true, guid }`. The device keeps its credentials; this is also how to see which GUID a unit believes it has.
3. The request can land on either IIS server, and either can talk to dynsec (see "Who talks to dynsec"). The server claims the unit (first contact: inserting its row; pending: one conditional update), creates the broker account, and only then activates the row and answers, so the device never holds a password for an account that does not exist. If the broker step fails the row returns to `pending` and the device retries. Firmware should allow about 20 s.
4. Device connects to 8883 as `{guid}` and stays connected whether or not it is placed. Its data reaches its current placement: the one live, unarchived device row holding its MAC. With none, the data is dropped quietly.
5. Placing, moving or removing it never touches its credentials: adding its MAC to a location makes a new placement and data starts arriving at once; removing it (archive or delete) leaves it connected with nowhere to deliver.
6. If MQTT login fails (Reprovision revoked it, or cleanup did), firmware falls back to the announce step and the HTTPS call. After Reprovision it gets a fresh password under the same GUID; after cleanup it is a first contact again. A unit issued credentials and never connected within 30 days is revoked by the daily cleanup.

Response codes arrive in `x-app-status` over HTTP 200 (`middleware/httpStatus.js`): 200 store or keep, 400 do not retry, 409 another attempt is issuing so retry in seconds, 429 retry after the minute, 500 retry with backoff.

Endpoint hardening: rate limit per IP (`PROVISION_RATE_PER_MINUTE`, default 10; an in process bucket
dropped whole every minute, so the ceiling is per farm process, not global, and `trust proxy` is on,
which means a caller can choose its own bucket with an `x-forwarded-for` header: this is a flood
brake, not a security control). A password is only ever sent by the request that issued it; an active unit is told `existing` and never gets its password again. Every path
under the mount answers JSON, including the router's own error handler, because
`middleware/errors.js` renders an HTML page for anything outside `/api/` and a device must never be
sent one.

Optional, not adopted: a device generated random boot id (16+ bytes from the hardware RNG, stored in flash, sent with the POST and pinned in `device_registry` at first contact in the shop). It would let the server require a match on every later issue, so knowing a MAC during a pending window would not be enough to obtain credentials.

## Identity model (changed Sep 2026, migration 0020)

- **Unit:** one physical piece of hardware, keyed by **MAC**. Its `device_credentials` row holds the MQTT username (a GUID), the password and the state. It lives across placements and is revoked only by Reprovision or the 30 day never-connected cleanup. `device_registry` is its permanent birth record (never deleted), holding first and last firmware.
- **Placement:** a `DTM_devices` row, one stint of a unit at one location, owning sensors, history and alarms. Its uid is not a broker identity.
- **Current placement** is derived, not stored: the one live, unarchived device row with the unit's MAC as `hardware_id` (`ux_DTM_devices_hardware_id` allows at most one). None means unclaimed.
- When a MAC appears somewhere new, a human still chooses:
  - **Archive there, add as new here**: old row archived in place with its history, a new row at the new location. Nothing from the past life mixes in, because history belongs to placements. The unit's credentials are unchanged, so nothing reprovisions.
  - **Move it here**: same row, history travels. Credentials unchanged.
- A device row is never detached by clearing `location_id`.
- Before this change the MQTT username was the device row GUID. Units provisioned then keep that GUID as their unit GUID, so their topics did not change.

## Per device dynsec objects

Provision = ONE publish to `$CONTROL/dynamic-security/v1` with a `commands` array, processed in order, one response message for the batch. Format per the v2.0.22 plugin README:

```
{
    "commands":
    [
        {
            "command": "createRole",
            "rolename": "dev-<guid>",
            "correlationData": "<id>",
            "acls":
            [
                { "acltype": "publishClientSend", "topic": "dev/<guid>/#", "priority": 5, "allow": true },
                { "acltype": "subscribePattern", "topic": "dev/<guid>/cmd/#", "priority": 5, "allow": true },
                { "acltype": "publishClientReceive", "topic": "dev/<guid>/cmd/#", "priority": 5, "allow": true }
            ]
        },
        {
            "command": "createClient",
            "username": "<guid>",
            "password": "<generated>",
            "correlationData": "<id>",
            "roles":
            [
                { "rolename": "dev-<guid>", "priority": 5 }
            ]
        }
    ]
}
```

- Remove = one publish with `deleteClient` then `deleteRole`. Disable = `disableClient`. Rotate = `setClientPassword`.
- `correlationData` is a string, set per command, echoed in that command's entry in the response. Replies go to EVERY subscriber of the response topic (NULL client) at QoS 0, so correlation is mandatory and a reply can be lost (verified in the 2.0.18 source, the deployed version, `plugin.c:230` and `:252`).
- Idempotency, with the exact strings from the 2.0.18 source: `Role already exists` on `createRole` is followed by `modifyRole` (replaces the ACL set, so a stale role is repaired); `Client already exists` on `createClient` is followed by `setClientPassword`; `Client not found` and `Role not found` on delete count as done. A failing command does not abort the rest of its batch (`plugin.c:735`).
- Role ACL types are `publishClientSend`, `publishClientReceive`, `subscribeLiteral`, `subscribePattern`, `unsubscribeLiteral`, `unsubscribePattern`. Plain `subscribe` and `unsubscribe` are only valid for `setDefaultACLAccess`, not in a role.
- Subscribe and receive are limited to `dev/{guid}/cmd/#` on purpose. MQTT 3.1.1 delivers a publish to every matching subscriber including the publisher, and the gateways connect as 3.1.1, so a gateway subscribed to its whole tree would get its own data back. Everything the server sends to a device goes under `dev/{guid}/cmd/...`.
- MQTT client id = `{type}-{hardware_id}` (example `gw7080-7c4fad842518`). Unique per device and identical on every boot (the broker keys persistent sessions on it). It does not affect ACLs. The broker log prints both client id and username on each connect, so the GUID is not repeated in it.
- **Resolved, receive ACL:** `mqtt/topics.deviceAcls()` emits `subscribePattern` and
  `publishClientReceive` from one loop, so they cannot be separated, and every create reads the role
  back with `getRole` and throws if an ACL is missing. A daily audit (`listRoles` verbose, one round
  trip) flags any role that drifts, on the device page.
- **Resolved, cmd topic shape:** ACLs use the subtree `dev/{guid}/cmd/#`; the server still publishes
  to the bare `dev/{guid}/cmd`, which `#` matches (receive check is `mosquitto_topic_matches_sub`,
  `acl.c:44`). `dev/{guid}/cmd/reboot` needs no ACL change later.
- Optional later hardening: bind the client id to the dynsec client (`clientid` on `createClient`, or `setClientId`; both in the v2.0.22 README) so username, password and client id must all match.

## Who talks to dynsec

Any devmon process (changed Sep 2026; this section previously said the leader only). Provisioning, reprovision and delete all run on whichever IIS server took the request, and each can talk to dynsec directly.

- Control API: publish JSON to `$CONTROL/dynamic-security/v1`; results arrive on `$CONTROL/dynamic-security/v1/response`. Subscribe to the response topic before sending any command.
- Connection: `mqtts://iot.datatelematics.io:8883` as the `MQTT_DYNSEC_USER` site setting (`dynsec_admin`), opened on first use and kept open. Reconnected by `mqtt/watch.js` when MQTT settings change.
- Client id: `<MQTT_CLIENT_ID>-dynsec-<host>-<pid>`, clean session, the same pattern as the realtime relay. Unique per process because `MQTT_CLIENT_ID` is the same on every farm member and a shared id would let two processes evict each other; clean so a pid that changes on every restart leaves no orphan session. Several admin connections at once are fine: replies are matched by `correlationData`.

## Operating notes

- On the broker box, `mosquitto_ctrl` reads `~/.config/mosquitto_ctrl` (mode 600) for the `administrator` user, so `mosquitto_ctrl dynsec listClients`, `listRoles`, `getRole <name>`, `getDefaultACLAccess` work without prompts. Its "running without encryption" warning is expected there (loopback).
- dynsec changes take effect immediately and persist across broker restarts.
- Instant rollback of the receive default if something goes quiet: `mosquitto_ctrl dynsec setDefaultACLAccess publishClientReceive allow`.
- Internal clients that use the public host name appear in the broker log as `172.30.1.254` (firewall inside address).
- `dynsec_admin` can log in on 8883 from anywhere. Keep that password long and random, stored with the app's encrypted settings.

## Open items

- **Web server certificate CA:** firmware pins ISRG Root X1 for the broker. The HTTPS provisioning host may use a different CA, and an embedded TLS stack can only verify roots it carries. Check the CA of the IIS site's certificate, then set a rule: provisioning hosts use a CA already in firmware, or firmware carries a small set of roots.
- **Resolved, the other way:** archive and delete no longer remove the broker account, nor does anything placement related. The account belongs to the unit and is revoked only by Reprovision or the never-connected cleanup (Identity model above).
- **Check the intermediate server's remove behavior:** if it clears `location_id` on removal instead of archiving, history from a unit's past placement can mix into its next one.
- **Legacy `device` client:** before deleting it, list who uses it. Live traffic on `/dom/<mac>/status` was seen on 2026-09-20 from field devices (model `ibt-ctl-eink`, cellular):
  `sudo grep -o "as [^ ]* (p[0-9], c[0-9], k[0-9]*, u'device')" /var/log/mosquitto/mosquitto.log | sort | uniq -c | sort -rn | head -n 20`
- **`legacy_full`:** replace with scoped roles for `devmon_server` and `server_admin` once the topic usage of each is listed. Each new role needs send, subscribe, and receive ACLs.
- **Cert renewal copy:** confirm whether the copy into `/etc/mosquitto/ca_certificates/` plus broker restart is a certbot deploy hook or manual. If manual, the broker serves an expired cert on 2026-11-22 and every TLS client drops.
- **Chain sent by the broker:** Let's Encrypt now issues leaf <- YR2 <- Root YR <- ISRG Root X1. Pin ISRG Root X1, never an intermediate. Confirm the broker sends the full chain before building firmware:
  `openssl s_client -connect localhost:8883 -servername iot.datatelematics.io -showcerts </dev/null 2>/dev/null | grep -E " s:| i:"`
  Expect three certs. If only the leaf appears, point `certfile` at the fullchain copy.
- **Tuya thermostats:** publish outside `dev/{guid}/#`. Add a second small role (send, plus subscribe and receive if needed) for their topic and attach it to those clients only.