# Device provisioning: firmware guide

How a gateway (or a direct device) gets its MQTT credentials from devmon, and what it does when it
is connected, when a connection fails, and when its credentials stop working. Written for firmware
work; the server side is in `DECISIONS.md` and `dynsec-broker-summary.md`. Verified end to end
against the live broker on 2026-09-21 with `scripts/provision-test.sh`.

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
| Broker | `iot.datatelematics.io`, port 8883, TLS |
| Broker root CA | ISRG Root X1 (pin the root, never an intermediate) |
| First contact login | username `announce`, password: the shared value, the same in every image |
| Its own MAC | 12 hex digits |
| Its model string | e.g. `gw-cell-1`. Must exactly match a model the server lists; it decides the device type |
| Its firmware version | free text, e.g. `1.4.2` |

Stored in flash after provisioning: **GUID and password**. Nothing else is needed. Do not store the
provisioning URL permanently; read it fresh each time (step 1), because the server can move it.

## Step 1: learn the provisioning URL

1. Connect to the broker as `announce`. It can read exactly one topic and do nothing else.
2. Subscribe to `con/endpoint`. It is retained, so the message arrives immediately.
3. Parse the JSON, disconnect.

```json
{"url":"https://devmon.datatelematics.io/provision/v1","published":"2026-09-21T03:17:41Z"}
```

Use `url`. Ignore every other field (`published` is for humans; more fields may be added later).
If no message arrives within about 10 seconds, retry with backoff (see Timing).

## Step 2: request credentials over HTTPS

`POST` to the `url` from step 1, `Content-Type: application/json`, timeout **20 seconds** (the
server creates the broker account before it answers, which takes a few round trips):

```json
{ "hw": "A4CF12345678", "model": "gw-cell-1", "fw": "1.4.2" }
```

- `hw`: the MAC. Separators and lower case are accepted; 12 hex digits after cleanup.
- `model`: required, exact match. The server finds the device type whose module lists this model;
  a model no type lists is refused with 400. A new product needs its model added on the server first.
- `fw`: optional but send it. It shows on the server's device and unknown devices pages.

### Reading the answer: the code is in a header, not the status line

**The HTTP status is always 200** (the IIS servers replace the body of any error response, so the
app never sends one). The real result is the **`x-app-status`** response header. No header means
200. The body is JSON, with one exception: for a few seconds while the site is starting, the answer
is `x-app-status: 503` with a short HTML page. Treat that like any 503.

| `x-app-status` | Body | Do this |
|---|---|---|
| (none) with `password` | `{"ok":true,"guid":"...","password":"..."}` | Store GUID and password, go to step 3 |
| (none) with `existing` | `{"ok":true,"guid":"...","existing":true}` | You already hold active credentials. Keep yours and go to step 3. See "Existing" below |
| 400 | `{"ok":false,"status":400,"error":"..."}` | Bad request (bad MAC, missing `model`, or a model the server does not list). Do not retry the same request; log `error` |
| 409 | `{"ok":false,"status":409,"error":"...","guid":"..."}` | Another request for this unit is being processed. Retry in 5 seconds |
| 429 | `{"ok":false,"status":429,"retry_after_secs":N}` | Rate limited. Wait `retry_after_secs`, then retry |
| 500, 503 | `{"ok":false,"status":500,...}` | Temporary server problem. Retry with backoff |

If the HTTP status itself is not 200, or the body is not JSON, the request never reached the app
(the site is down or restarting, or a proxy answered). Treat it as temporary and retry with backoff.

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
| Client id | `{model}-{mac}`, e.g. `gw7080-7c4fad842518`. The same on every boot and unique per unit; two connections with the same id evict each other |
| Keepalive | 60 s |
| Last will | topic `dev/{guid}/status`, payload `{"online":false}`, retained, QoS 1 |

Once connected:

1. Subscribe to **`dev/{guid}/cmd/#`**, QoS 1. Only that. The broker refuses any other subscription,
   and subscribing to your whole `dev/{guid}/#` tree would echo your own uplinks back to you.
2. Publish `dev/{guid}/status`, **retained**, with the connect message (connect event, `firmware`,
   csq, ipa, model, board, method, is_secure). Then publish nwinfo and the radio mode to the same
   `dev/{guid}/status` topic, **not retained**. A non-retained publish does not replace the stored
   retained connect message, so the broker keeps the connect message as the unit's current state.
3. Publish the reboot reason (`reboot_reason`, `reboot_desc`, `reboot_count`, `is_secure`) to
   `dev/{guid}/data`, not retained.
4. Publish each config value to `dev/{guid}/config/{key}`, one value per publish, **not retained**.
5. Publish the geoscan to `dev/{guid}/geoscan`, not retained.
6. From then on, publish your own readings to `dev/{guid}/data` (not retained) and relayed traffic
   to `dev/{guid}/frame` and `dev/{guid}/ble`, all QoS 1.
7. Handle commands arriving on `dev/{guid}/cmd` and anything under it (`gateway-protocol.md` 5).

### Uplink topics

| Topic | Retained | Payload |
|---|---|---|
| `dev/{guid}/status` | connect message only | connect message (retained), nwinfo and radio mode (not retained). Firmware version as `firmware`. LWT `{"online":false}` |
| `dev/{guid}/data` | no | flat JSON of the unit's own readings (keys below), and the reboot reason message |
| `dev/{guid}/config/{key}` | no | the bare value, e.g. topic `.../config/rf_channel`, payload `11` |
| `dev/{guid}/cmd_ack` | no | `{"event":"cmd_ack","value":...,"response"|"result":...}` when a command was heard |
| `dev/{guid}/geoscan` | no | `{"event":"geoscan","wifi":[{bssid,ssid,rssi,ch}],"cell":{mcc,mnc,tac,cid}}` |
| `dev/{guid}/frame` | no | one relayed LoRa frame (`gateway-protocol.md` 4.1) |
| `dev/{guid}/ble` | no | one beacon per publish, the existing keys: `{"dmac":"bc57291ec984","rssi":-100,"count":16,"data":"<hex>"}`, optional `seconds_ago`. Not the 4.3 batch (see DECISIONS) |

gw7080 `data` keys are the existing `publishStatus()` payload, unchanged: only the topic moves from
`data/json/node/1` to `data`. Every key is optional, `null` is skipped, and extra keys are ignored.

| Key | Unit | Notes |
|---|---|---|
| `cycles` | count | publish cycles since boot |
| `vin`, `vbat` | V | |
| `int_temp` | degrees C | `null` without an SHTC3 |
| `int_hum` | %RH | `null` without an SHTC3 |
| `modem_csq` | CSQ 0 to 31 | raw index, 99 = unknown; on cellular |
| `wifi_rssi` | dBm | on WiFi, in place of `modem_csq` |
| `run_time` | minutes | |
| `free_heap` | bytes | |
| `charge_state`, `charge_adc`, `charge_disable`, `charge_disable_remaining_m` (minutes), `charge_disable_src` | | `null` on board 1.1 |
| `wifiap_clients` | count | only while the WiFi AP is running |

Do not send `batt_pct`: battery percentage will be derived on the server from `vbat` by a battery
chemistry helper. A signal percentage will be derived from `modem_csq` the same way.

### Config writes from the server

The server writes one key at a time to `dev/{guid}/cmd/set_config/{key}`, payload the bare value,
QoS 1, **not retained** (the existing `cmd/set_config/` handler). After applying it, publish
`dev/{guid}/config/{key}` with the value now held; that reply is what confirms the write on the
server, which shows the key as pending until it arrives. Writes the unit has not confirmed are sent
again each time the unit publishes its connect message, so a unit that was offline gets them on
its next connect. `publishConfig()` on connect also confirms anything applied during a reboot
(`ble_relay_mode` reboots without replying).

Only retain the connect message on `status`. Nothing else may be retained: a retained message is replayed to the server on
every reconnect of its ingest client and after a broker restart.

Publishing anywhere outside your own `dev/{guid}/` tree is refused by the broker.

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
    connected        -> subscribe dev/{guid}/cmd/#, publish status online:true, run
  connection lost    -> backoff, retry CONNECT
```

## Testing a unit by hand

From the repository, with a made up MAC (keep the second hex digit 2, 6, A or E, for example
`020000000001`, so it can never collide with real hardware):

```
ANNOUNCE_PASSWORD='...' ./scripts/provision-test.sh --broker iot.datatelematics.io --mac 020000000001
node scripts/reset-test-unit.js 020000000001 --yes     # remove it completely, to test first contact again
```

## Open items for firmware

- **HTTPS chain.** The site uses a Let's Encrypt certificate, the same hierarchy as the broker, so the
  pinned ISRG Root X1 covers both, provided the server sends the full chain up to the root. TLS is
  terminated in front of IIS (ARR), so check what devices actually receive before building firmware:
  `openssl s_client -connect devmon.datatelematics.io:443 -servername devmon.datatelematics.io -showcerts </dev/null | grep -E " s:| i:"`
  Expect the leaf, the intermediate, and a certificate issued by ISRG Root X1.
- **Clean session.** `gateway-protocol.md` says clean session. With QoS 1 commands, a persistent
  session would also deliver commands sent while the device was offline. Decide which is wanted.
- **gw7080 topics (settled Sep 2026).** Status, data, config and geoscan as in "Uplink topics" above.
  The legacy `data/json/node/1` and `nwinfo` topics are gone from the `dev/` tree. The server logs
  config and geoscan but does not store them yet.
- **Legacy MQTT provisioning** (`provision/request/{hw}` with the old bootstrap user) still works for
  fielded firmware and goes away once the HTTPS flow has shipped.
