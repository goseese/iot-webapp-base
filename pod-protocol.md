# Pod protocol: firmware contract

Version 1, September 2026. What controller pods, account pods and target pods send and receive,
between each other and with the server. Written for the firmware; the server follows it.

Sections marked **Later** are agreed in outline but not built on the server yet. Their message
formats are fixed here anyway, so firmware can plan for them and the broker permissions a pod gets
when it provisions already cover them.

Related documents:
- `device-provisioning.md`: how a controller or account pod gets broker credentials, logs in and
  reconnects. Everything there applies unchanged; this document does not repeat it.
- `DECISIONS.md`, "Pod stations": the server side of pairing and placement.

## 1. The pieces

```
                    MQTT over TLS (8883), dynsec credentials
  server  <------------------------------------------------->  controller pod (vpod-ctl)
                                                                   |   ESP-NOW, unicast
                                                                   +-> target pod (vpod-acc, vpod-tof)
                                                                   +-> target pod ...
  server  <------------------------------------------------->  account pod (vpod-acct)
```

- **Controller pod** (`vpod-ctl`): runs one training station. Logs in to the broker, relays its
  target pods' traffic, and later reads wristbands at check in.
- **Account pod** (`vpod-acct`): logs in to the broker like a controller. Has no target pods.
  Later it enrolls wristbands.
- **Target pods** (`vpod-acc` impact, `vpod-tof` laser): never use MQTT. They talk only to the
  controller they joined, over ESP-NOW. The server refuses to provision their models.
- **Tablets** talk to the server over HTTPS and websockets only. No pod talks to a tablet.

Every MAC in every JSON payload is the station MAC as 12 upper case hex digits with no separators,
for example `A4CF12345678`. The server also accepts lower case and colons, but firmware should not
rely on that.

## 2. Controller and account pods on MQTT

Provisioning, the login, the client id `{model}-{mac}`, the last will, backoff and the handling of
refused credentials are exactly as `device-provisioning.md` describes, with model `vpod-ctl` or
`vpod-acct`.

The AP mode setup (function button, access point, WiFi credentials and broker host) stays exactly as
it is in the current firmware.

### Topics

All under the pod's own `dev/{guid}/`. The broker allows nothing else.

| Direction | Topic | Retained | Payload |
|---|---|---|---|
| up | `status` | connect message only | connect message: `{"event":"connect","firmware":"1.0.3"}`. Last will `{"online":false}` |
| up | `data` | no | the pod's own readings, section 3.1 |
| up | `frame` | no | one relayed target pod message, section 3.2 |
| up | `config/{key}` | no | one config value, bare, section 4 |
| up | `cmd_ack` | no | the answer to a queued command, section 5 |
| up | `event` | no | **Later**: wristband reads and game events, section 8 |
| down | `cmd/q` | no | a queued command, section 5 |
| down | `cmd/set_config/{key}` | no | a config write, bare value, section 4 |

Subscribe to `dev/{guid}/cmd/#` at QoS 1 and nothing else. Publish uplinks at QoS 1.

On every connect, in this order: subscribe, publish the connect message (retained), publish every
config value, then publish `data` once. The server sends pending config writes and the next queued
command when it sees the connect message.

## 3. Readings

Send readings every `report_secs` seconds (default 600) and once right after connecting or joining.
Payload keys are the firmware's own; the server maps them to its sensor names. Unknown keys are
ignored and `null` values skipped, so a key can be added to firmware before the server uses it. Do
not send percentages: the server derives battery percent from `vbat` and signal percent from the
raw RSSI.

### 3.1 A controller's or account pod's own readings: `dev/{guid}/data`

```json
{"vin":12.1,"vbat":4.02,"charge_state":1,"int_temp":24.6,"int_hum":41.2,"run_time":86400,"free_heap":181240,"wifi_rssi":-58}
```

| Key | Unit | Meaning | Server sensor |
|---|---|---|---|
| `vin` | V | 12 V supply as measured | Power in (`vin`) |
| `vbat` | V | backup Li-Ion cell | Battery voltage (`int-vbat`), and Battery % derived |
| `charge_state` | 0, 1, ... | charger state as the firmware defines it | Charge state (`charge-state`) |
| `int_temp` | °C | board temperature (SHTC3) | Board temperature (`int-temp`) |
| `int_hum` | %RH | board humidity (SHTC3) | Board humidity (`int-humidity`) |
| `run_time` | s | seconds since boot | Uptime (`run-time`) |
| `free_heap` | bytes | free heap | Free heap (`free-heap`) |
| `wifi_rssi` | dBm | RSSI to the WiFi access point | WiFi RSSI (`wifi-rssi`), and WiFi signal % derived |

### 3.2 A target pod's readings, relayed: `dev/{guid}/frame`

The target pod sends its readings to its controller over ESP-NOW (section 7). The controller
publishes each one as it arrives, adding the target's MAC and the RSSI it received it at:

```json
{"mac":"A4CF12345678","rssi":-58,"model":"vpod-acc","fw":"1.0.3","boot":12,"seq":1841,"data":{"vin":12.1,"vbat":4.02,"charge_state":1,"int_temp":24.6}}
```

| Field | Meaning |
|---|---|
| `mac` | the target pod's MAC |
| `rssi` | dBm, what the controller received this message at |
| `model`, `fw` | the target pod's model string and firmware version |
| `boot` | the target pod's boot count, kept in NVS, incremented at every boot |
| `seq` | per boot message counter, starting at 1 |
| `data` | the target pod's readings, same keys as 3.1 without `wifi_rssi` |

The server drops duplicates by `boot * 2^32 + seq`, so a message relayed twice counts once. Without
`boot` the counter is `seq` alone, and after a reboot the pod's messages are dropped as duplicates
until `seq` passes its old value, so always send `boot`. The server keeps the controller's `rssi` per
controller and shows it in the station list.

## 4. Config

Config writes, confirmations and resending are as `device-provisioning.md` describes: the server
publishes `dev/{guid}/cmd/set_config/{key}` with the bare value; the pod applies it, saves it, and
publishes `dev/{guid}/config/{key}` with the value it now holds. The key shows as pending on the
server until that reply arrives.

| Key | Pods | Kind | Default | Meaning |
|---|---|---|---|---|
| `pair_mode` | controller | `true` / `false` | `false` | Accept join requests (section 6). Stays on until the server turns it off, across reboots. LEDs blue while on |
| `report_secs` | all | integer, 60 to 86400 | 600 | Seconds between readings |
| `band_rssi_min` | controller, account | integer dBm | -50 | **Later**: weakest wristband signal to accept (section 8) |

A **target pod's** config is set with the queued `set_config` command (section 5) through its
controller. The target applies and saves it, and acks. The ack is the confirmation.

## 5. Queued commands

Every command the server sends to a pod, or through a controller to a target pod, is queued on the
server. It shows as **queued** until it is sent, **sent** until the pod acks it, then **done** or
**failed**. A queued or sent command can be cancelled in the web app, which removes it; a pod that
already has it may still carry it out.

### 5.1 Server to pod: `dev/{guid}/cmd/q`

```json
{"id":"8f3c2a1e","to":"A4CF12345678","cmd":"led","value":"00FF00"}
```

| Field | Meaning |
|---|---|
| `id` | the command's id, a string of up to 36 characters. The ack carries it back |
| `to` | absent: the pod this was published to. A MAC: that one target pod. `"all"`: every target pod paired with this controller |
| `cmd` | the command name, section 5.4 |
| `value` | optional; its form depends on the command |

For `"all"` the controller sends the command to each of its target pods **one unicast message per
MAC**, never an ESP-NOW broadcast, so no other station's pods can hear it.

### 5.2 Pod to server: `dev/{guid}/cmd_ack`

```json
{"id":"8f3c2a1e","ok":true,"results":{"A4CF12345678":"ok"}}
```

| Field | Meaning |
|---|---|
| `id` | the command's id |
| `ok` | `true` when the command was carried out everywhere it was sent |
| `results` | for commands to target pods: one entry per MAC, below. Absent for a command to the pod itself |
| `error` | optional short text when `ok` is `false` |

Per target results: `"ok"`; `"no_ack"` (the target did not answer, section 7.4); `"not_paired"` (that
MAC is not one of this controller's target pods); `"error"` (the target answered with an error).

### 5.3 The rules

1. **One command in flight per pod.** The server publishes the next queued command for a pod only
   after the previous one is acked. Commands to a controller's target pods share the controller's
   queue, in order.
2. **Resent on connect.** A command sent but not acked is published again, with the **same id**,
   when the pod next publishes its connect message.
3. **Same id, do it once.** A pod that receives an id it has already carried out acks it again
   without carrying it out again. Keep at least the last 16 ids.
4. **Ack when done, except reboot.** Ack after the command has been applied. For `reboot`, ack
   first, wait about 1 s for the ack to go out, then reboot; otherwise the resend on connect reboots
   the pod again, forever.
5. **Unknown command:** ack with `"ok":false,"error":"unknown command"`. Never leave a command
   unacked: it blocks the pod's queue.

### 5.4 Commands in version 1

| `cmd` | For | `value` | Does |
|---|---|---|---|
| `led` | target pods (also controllers, for testing) | `"RRGGBB"` hex, or `"off"` | Sets the whole LED grid to one color |
| `set_config` | target pods | `{"key":"report_secs","value":"600"}` | Sets one config key (section 4) |
| `publish_now` | any pod | none | Sends readings now (a target pod through its controller) |
| `reboot` | any pod | none | Acks, then reboots (rule 4) |

Game setup, start and stop commands are **Later**. They will use this same queue and message format.

## 6. Joining a target pod to a controller

Joining happens only while the controller's `pair_mode` is on. The web app allows one controller
per location to be in pairing mode at a time.

### 6.1 On the target pod

1. Press and hold the function button. The existing AP mode starts as today and the whole LED grid
   turns **yellow**. Releasing the button here keeps today's AP mode behavior, unchanged.
2. Keep holding **2 more seconds**. The grid turns **blue**: join mode. AP mode is left.
3. Release. The pod immediately sends its join request (`join`, 7.1) as an ESP-NOW broadcast. The pod
   does not know the controller's WiFi channel yet, so it sends on channel 1, waits about 150 ms
   for an answer, then channel 2, and so on to 13, and repeats the sweep for up to 30 s.
4. On `join_ok` from a controller: save that controller's MAC and the channel in NVS, turn the grid
   **green for 1 second**, then go idle with the LEDs off. Send readings once right away (3.2).
5. No answer within 30 s: turn the grid **red** for 1 second and go idle, still joined to its
   previous controller if it had one.

After joining, the target accepts messages only from its saved controller's MAC. It keeps its radio
listening while idle: the pods run on 12 V, and a pod in deep sleep cannot hear commands.

Joining another controller replaces the saved one. The server then moves the pod to the new
controller's station, history and all.

If the saved controller stays silent for a long time (the controller's router may have changed
channel), the target sweeps channels again, sending `hello` (7.1) instead of `join`, and accepts
an answer only from its saved controller.

### 6.2 On the controller

1. While `pair_mode` is on, the LEDs are **blue**. It answers every valid join request with
   `join_ok` (7.2), adds the target as an ESP-NOW peer, and saves its MAC and model in NVS.
2. It relays each join to the server as a frame with `"event":"join"` (section 7.5). The server
   creates or moves the target pod's placement only when it arrives through a controller whose
   reported `pair_mode` is on.
3. While `pair_mode` is off, it ignores join requests entirely and sends nothing back.
4. **At most 19 target pods** (the ESP-NOW peer table holds 20, one of them the broadcast entry).
   A join request beyond that gets no answer.

## 7. ESP-NOW messages

JSON, at most 250 bytes (the ESP-NOW v1 limit, which every ESP-IDF version supports). Every message
has `t` (its type) and `v` (this protocol's version, `1`). The sender's MAC comes from ESP-NOW
itself (the receive callback's source address), so it is not repeated in the JSON.

A pod ignores any message whose `v` it does not know, and any message from a MAC it does not
expect: a target listens only to its saved controller (and, in join mode, to `join_ok`); a
controller listens only to its own target pods (and, while `pair_mode` is on, to `join`).

### 7.1 Target to controller

| `t` | Example | When |
|---|---|---|
| `join` | `{"t":"join","v":1,"model":"vpod-acc","fw":"1.0.3","boot":12}` | join mode, broadcast (6.1) |
| `hello` | `{"t":"hello","v":1,"model":"vpod-acc","fw":"1.0.3","boot":12}` | looking for its saved controller again (6.1), broadcast |
| `data` | `{"t":"data","v":1,"model":"vpod-acc","fw":"1.0.3","boot":12,"seq":1841,"d":{"vin":12.1,"vbat":4.02}}` | every `report_secs`, unicast |
| `ack` | `{"t":"ack","v":1,"id":"8f3c2a1e","ok":true}` | after each `cmd`, unicast. `"ok":false,"err":"..."` on error |

### 7.2 Controller to target

| `t` | Example | When |
|---|---|---|
| `join_ok` | `{"t":"join_ok","v":1}` | answer to `join` while pairing, unicast |
| `here` | `{"t":"here","v":1}` | answer to `hello` from one of its own target pods, unicast |
| `cmd` | `{"t":"cmd","v":1,"id":"8f3c2a1e","cmd":"led","value":"00FF00"}` | a queued command, unicast |

### 7.3 Join and hello

The target learns the channel from the one it was sweeping when the answer arrived. Both `join`
and `hello` carry model, firmware and boot count, so the controller can relay them to the server.

### 7.4 Delivery

ESP-NOW's own send status only says the radio frame was acknowledged. The `ack` message says the
command was carried out. The controller waits up to 500 ms for a target's `ack`, resends the `cmd`
up to 2 more times, then reports `"no_ack"` for that MAC. A target that receives the same `id` twice
acks again without repeating the command (rule 5.3.3).

### 7.5 What the controller publishes for each

| ESP-NOW message | MQTT `dev/{guid}/frame` payload |
|---|---|
| `join` (while pairing) | `{"mac":"...","rssi":-58,"model":"vpod-acc","fw":"1.0.3","boot":12,"event":"join","data":{}}` |
| `data` | as 3.2, `d` becomes `data` |
| `ack` | nothing on `frame`: the controller collects acks into the `cmd_ack` for that command (5.2) |

## 8. Wristbands (Later)

The bands are BLE 5.0 beacons advertising an iBeacon payload on the **Coded PHY** (long range),
and can be set to advertise only while their button is pressed.

- **Scanning:** Coded PHY advertising is only received by a BLE 5 **extended** scan with the Coded
  PHY enabled; a legacy scan does not see it. The existing GSE gateway firmware already reads these
  beacons with its own library: reuse that code (its source comes with this document to the
  firmware work) rather than starting over.
- **Button-press advertising:** recommended. A band then checks in only when the athlete means it
  to. It also means a press is short, so the pod should scan continuously rather than in bursts, or
  it can miss the press.
- **Which band:** accept only bands at or above `band_rssi_min` (section 4); when several are heard
  within a short window, take the strongest. Report the same band again only after 5 s.
- **Band id:** the beacon's BLE address, as 12 hex digits, provided the beacon uses a public or
  static address (check the beacon's settings; a random rotating address would make every press
  look like a new band). The iBeacon fields go along as well.

Controller or account pod to server, `dev/{guid}/event`:

```json
{"event":"band","band":"C0FFEE123456","rssi":-38,"ibeacon":{"uuid":"FDA50693-A4E2-4FB1-AFCF-C6EB07647825","major":1,"minor":42}}
```

On a controller, the server shows the band's owner at that station until the next band. On an
account pod, the band is being enrolled: the server asks on the paired tablet whose band it is.

## 9. Target pod firmware updates (Later)

Two options, to be chosen when needed:

- **Over ESP-NOW:** Espressif's `esp-now` component has an OTA feature: the controller downloads
  the image over HTTP and sends it to several target pods at once. Target pods never need WiFi
  credentials. Needs the two OTA partition layout.
- **Over WiFi:** a queued command gives the target pod WiFi credentials and an image URL; it joins
  the WiFi, downloads, updates and reboots. Simpler, but WiFi credentials travel over unencrypted
  ESP-NOW.

Controller and account pods update over their own WiFi, by a queued command with the image URL.

## 10. Not in this version

- Game definitions, start and stop, hit and reaction time events (queued commands and `event`
  messages, same formats as above).
- Removing a target pod from its old controller's peer list when the web app moves or deletes it.
- Tablets: pairing by QR code, check in display, band enrollment screen (server and browser only).

## Sources

- ESP-NOW limits (20 peers, 250 byte payload in v1): ESP-IDF programming guide, ESP-NOW.
- ESP-NOW OTA: https://github.com/espressif/esp-now/blob/master/examples/ota/README.md
- BLE 5 extended scanning on ESP32-S3: https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/bluetooth/esp_gap_ble.html
