# Device provisioning: firmware guide

How a pod (a controller pod, an account pod, or any device that holds its own MQTT login) gets its
credentials from the Voltastc server, and what it does when it is connected, when a connection
fails, and when its credentials stop working. Written for firmware work; the server side is in
`dynsec-broker-summary.md` and `DECISIONS.md`. Target pods do not provision: they talk ESP-NOW to
their controller pod, which relays their data under its own login.

## The model in one paragraph

Identity belongs to the physical unit, keyed by its MAC. The first time a unit contacts the server
it is issued a **GUID** (its MQTT username) and a **password**, whether or not anyone has added it to
a location yet. It keeps them for life: being added to a location, moved, or removed from one never
changes them, and the device is never told about any of it. If the unit is not placed anywhere, the
server simply drops its data; the device behaves exactly the same either way. Credentials only stop
working if someone clicks **Reprovision**, or if the unit was issued credentials and never connected
within 30 days. When they stop working, the device provisions again.

## What the firmware carries

| Item | Value |
|---|---|
| Broker | `app.voltastc.com`, port 8883, TLS |
| Root CA | ISRG Root X1, for both the broker and HTTPS (pin the root, never an intermediate) |
| First contact login | username `announce`, password: the shared value, the same in every image |
| Its own MAC | 12 hex digits |
| Its model string | must exactly match a model a device type on the server lists; it decides the device type |
| Its firmware version | free text, e.g. `1.4.2` |

Stored in flash after provisioning: **GUID and password**. Nothing else is needed. Do not store the
provisioning URL permanently; read it fresh each time (step 1), because the server can move it.

## Step 1: learn the provisioning URL

1. Connect to the broker as `announce`. It can read exactly one topic and do nothing else.
2. Subscribe to `con/endpoint`. It is retained, so the message arrives immediately.
3. Parse the JSON, disconnect.

```json
{"url":"https://app.voltastc.com/provision/v1","published":"2026-09-26T23:13:15Z"}
```

Use `url`. Ignore every other field (`published` is for humans; more fields may be added later).
If no message arrives within about 10 seconds, retry with backoff (see Timing).

## Step 2: request credentials over HTTPS

`POST` to the `url` from step 1, `Content-Type: application/json`, timeout **20 seconds** (the
server creates the broker account before it answers, which takes a few round trips):

```json
{ "hw": "A4CF12345678", "model": "<model string>", "fw": "1.4.2" }
```

- `hw`: the MAC. Separators and lower case are accepted; 12 hex digits after cleanup.
- `model`: required, exact match. A model no device type lists is refused with 400. A new product
  needs its model added on the server first.
- `fw`: optional but send it. It shows on the server's device and unknown devices pages.

### Reading the answer

The HTTP status code is the result. Bodies are JSON.

| Status | Body | Do this |
|---|---|---|
| 200 with `password` | `{"ok":true,"guid":"...","password":"..."}` | Store GUID and password, go to step 3 |
| 200 with `existing` | `{"ok":true,"guid":"...","existing":true}` | You already hold active credentials. Keep yours and go to step 3. See "Existing" below |
| 400 | `{"error":"..."}` | Bad request (bad MAC, missing `model`, or a model the server does not list). Do not retry the same request; log `error` |
| 409 | `{"error":"...","guid":"..."}` | Another request for this unit is being processed. Retry in 5 seconds |
| 429 | `{"error":"...","retry_after_secs":N}` | Rate limited. Wait `retry_after_secs`, then retry |
| 500, 502, 503 | JSON or a short HTML page | Temporary server problem (503 while the site is starting, 502 if the app is restarting). Retry with backoff |

Anything else, or a body that is not JSON on a 200, means the request did not reach the app as
expected. Treat it as temporary and retry with backoff.

The password is sent **once**, in the answer to the request that created it. It is never re-sent.
Write GUID and password to flash together, and only after a complete 200 answer with a password.

### Existing

`existing: true` means the server considers this unit's credentials active. Two cases:

- **The device has credentials in flash**: normal. Keep them and connect.
- **The device has none** (flash was lost or erased): it cannot recover on its own, because the
  password is never re-sent. Log the GUID the server returned, then keep retrying step 2 slowly
  (every hour). A person clicks **Reprovision** for this unit on the server, after which the next
  request is issued a fresh password under the **same GUID**.

## Step 3: connect as yourself

| Setting | Value |
|---|---|
| Username | the GUID |
| Password | the password |
| Client id | `{model}-{mac}`, lower case MAC. The same on every boot and unique per unit; two connections with the same id evict each other |
| Keepalive | 60 s |
| Last will | topic `dev/{guid}/status`, payload `{"online":false}`, retained, QoS 1. A clean DISCONNECT discards it, so publish the same yourself first, or use MQTT 5 reason 0x04 (`pod-protocol.md` section 2) |

Once connected:

1. Subscribe to **`dev/{guid}/cmd/#`**, QoS 1. Only that. The broker refuses any other subscription,
   and subscribing to your whole `dev/{guid}/#` tree would echo your own uplinks back to you.
2. Publish `dev/{guid}/status`, **retained**, with the connect message (connect event, `firmware`,
   and whatever connectivity details the type defines). Any later status publish is **not
   retained**, so the broker keeps the connect message as the unit's current state.
3. Publish each config value to `dev/{guid}/config/{key}`, one value per publish, **not retained**.
4. From then on, publish your own readings to `dev/{guid}/data` and relayed target pod traffic to
   `dev/{guid}/frame`, not retained, QoS 1.
5. Handle commands arriving on `dev/{guid}/cmd` and anything under it, and publish
   `dev/{guid}/cmd_ack` when a command is heard.

### Uplink topics

| Topic | Retained | Payload |
|---|---|---|
| `dev/{guid}/status` | connect message only | connect message (retained), other status (not retained). Firmware version as `firmware`. LWT `{"online":false}` |
| `dev/{guid}/data` | no | flat JSON of the unit's own readings; the keys are mapped by the device type's `dataMap` on the server |
| `dev/{guid}/config/{key}` | no | the bare value, e.g. topic `.../config/rf_channel`, payload `11` |
| `dev/{guid}/frame` | no | one relayed frame from a device this unit hears (a target pod) |
| `dev/{guid}/cmd_ack` | no | `{"event":"cmd_ack","value":...}` when a command was heard |
| `dev/{guid}/geoscan` | no | `{"event":"geoscan","wifi":[{bssid,ssid,rssi,ch}]}` if the product ever reports it |

Payload keys for `data` are the firmware's own; the server's device type maps them to its channel
names, so firmware never renames a key to suit the server. `null` values are skipped and unknown
keys ignored. Do not send percentages the server derives (battery percent from the battery voltage,
signal percent from the raw RSSI).

Publishing anywhere outside your own `dev/{guid}/` uplinks is refused by the broker. Only the
connect message on `status` may be retained: a retained message is replayed to the server on every
reconnect and after a broker restart.

### Config writes from the server

The server writes one key at a time to `dev/{guid}/cmd/set_config/{key}`, payload the bare value,
QoS 1, **not retained**. After applying it, publish `dev/{guid}/config/{key}` with the value now held;
that reply is what confirms the write on the server, which shows the key as pending until it arrives.
Writes the unit has not confirmed are sent again each time the unit publishes its connect message.
Publishing every config value on connect also confirms anything applied during a reboot.

### Commands

Commands arrive on `dev/{guid}/cmd/{name}` (and the bare `dev/{guid}/cmd`), with the firmware's own
command names as declared in the device type's `commands` list. They are never retained or queued by
the server: a command sent while the unit is offline is not delivered later.

Pods use queued commands instead, on `dev/{guid}/cmd/q` with an ack on `dev/{guid}/cmd_ack`: see
`pod-protocol.md`, section 5.

## When the MQTT connection fails

The rule that matters: **only an authentication refusal sends the device back to provisioning.**
Everything else is a network problem, and the credentials stay.

| What happened | Do this |
|---|---|
| CONNACK "bad username or password" or "not authorized" (MQTT 3.1.1 codes 4 or 5; MQTT 5 0x86 or 0x87) | Credentials were revoked. Go back to step 1 and provision again. Keep the old GUID and password in flash until a new pair has been received |
| No network, DNS failure, TCP or TLS failure, timeout, CONNACK "server unavailable" (3.1.1 code 3) | Keep the credentials. Retry the connection with backoff |
| Connected, then dropped | Reconnect with backoff using the same credentials |

After a revocation the server answers step 2 with a fresh password under the **same GUID**, or, if the
unit's record was cleaned up, with a new GUID. Either way, store whatever it returns.

### The loop to avoid

If step 2 answers `existing` while the broker keeps refusing the stored credentials, the server
thinks the account is fine and the broker does not. Retrying fast will not fix it. Back off to once
an hour and log the GUID. The server's daily broker check flags this on the device page, and the
fix is **Reprovision**.

## Timing

- Backoff for retries (steps 1, 2 and MQTT reconnects): 5 s, 15 s, 60 s, then every 5 minutes, with
  up to 20% random jitter so a batch of units powered on together does not retry in lockstep.
- The provisioning endpoint allows 10 requests per minute **per public IP address**. A shop full of
  units behind one NAT address shares that budget, which is another reason for the jitter. The limit
  is a server setting (`PROVISION_RATE_PER_MINUTE`) if the shop needs more.
- The HTTPS request can take several seconds; allow 20 s before treating it as failed.

## The whole flow

```
boot
  if flash has guid + password: goto CONNECT
PROVISION
  connect as announce, read retained con/endpoint -> url, disconnect   (retry with backoff)
  POST {hw, model, fw} to url                                           (20 s timeout)
    200 + password   -> store guid + password, goto CONNECT
    200 + existing   -> if flash has credentials goto CONNECT, else log guid, retry hourly
    409              -> wait 5 s, retry POST
    429              -> wait retry_after_secs, retry POST
    400              -> log error, stop retrying this request (fix firmware, or add the model on the server)
    anything else    -> backoff, retry
CONNECT
  mqtt connect as guid, client id {model}-{mac}, LWT on dev/{guid}/status
    auth refused     -> goto PROVISION
    other failure    -> backoff, retry CONNECT
    connected        -> subscribe dev/{guid}/cmd/#, publish retained connect message, run
  connection lost    -> backoff, retry CONNECT
```

## Testing a unit by hand

From any machine with mosquitto-clients, curl and python3, with a made up MAC (keep the second hex
digit 2, 6, A or E, for example `020000000001`, so it can never collide with real hardware) and a
model string a device type on the server lists:

```
ANNOUNCE_PASSWORD='...' ./scripts/provision-test.sh --broker app.voltastc.com --mac 020000000001 --model <model>
```

On the server, to remove the test unit completely and test first contact again:

```
cd /opt/voltastc && sudo runuser -u voltastc -- node scripts/reset-test-unit.js 020000000001 --yes
```

## Open items for firmware

- **Model strings:** the server provisions `vpod-ctl` (controller pod) and `vpod-acct` (account pod).
  Target pod models (`vpod-acc`, `vpod-tof`) get 400: they never connect to the broker
  (`pod-protocol.md`).
- **Certificate chain:** check what a device actually receives on 443 and 8883 before building
  firmware (see `dynsec-broker-summary.md`, Open items). Expect the leaf, the intermediate, and an
  issuer chaining to ISRG Root X1.
- **Clean session:** with QoS 1 commands, a persistent session would also deliver commands sent
  while the device was offline. Decide which is wanted per product.
