# Command protocol: queued commands and firmware updates

What a gateway sends and receives for queued commands, firmware updates and relayed JSON frames.
Written for the firmware; the server follows it. Taken from the Voltastc pod protocol (version 1,
September 2026), whose controller pod firmware the gw7080 gateway was forked from. The pod only
parts (target pod pairing over ESP-NOW, wristbands, games) were removed with the pod types.

A device type opts in: `commandQueue: true` puts its commands through the queue (section 2),
`firmwareImage` names the image it installs (section 3). Every other type's commands are published
straight away on `dev/{guid}/cmd/{name}`, unqueued.

Related documents:
- `device-provisioning.md`: how a gateway gets broker credentials, logs in and reconnects, and the
  config writes (`cmd/set_config/{key}`, confirmed on `config/{key}`). Not repeated here.
- `DECISIONS.md`, "Queued commands" and "Firmware updates": the server side.

**Not wired on the server yet:** addressing a command to a node behind the gateway (`to` a MAC or
`"all"`, below). The server routed those through a pod's controller (`devices.controller_id`), which
was removed with the pod stations. Commands to the gateway itself work. To be reworked with the
gw7080 queue.

## 1. Topics and going offline

All under the gateway's own `dev/{guid}/`.

| Direction | Topic | Retained | Payload |
|---|---|---|---|
| up | `status` | connect message only | connect message: `{"event":"connect","firmware":"1.0.3"}`. Last will `{"online":false}` |
| up | `frame` | no | one relayed node message as JSON, section 4 |
| up | `cmd_ack` | no | the answer to a queued command, section 2 |
| up | `event` | no | firmware update progress (section 3); anything else goes to the event log |
| down | `cmd/q` | no | a queued command, section 2 |

The server sends the next queued command when it sees the connect message.

### Going offline: always say so

The server shows a gateway online or offline from `status`, so `{"online":false}` must arrive
however the connection ends:

- **Unexpected loss** (power, WiFi or cell gone, crash): the broker publishes the last will,
  `{"online":false}`, retained, after the connection drops or after about 1.5 times the keepalive
  (90 s at 60 s) of silence. Nothing to do in firmware beyond setting the will.
- **Deliberate disconnect** (reboot command, firmware update, shutdown): a normal MQTT DISCONNECT
  makes the broker **discard** the will, so do one of these first:
  - publish `{"online":false}` to `dev/{guid}/status` yourself, **retained**, QoS 1, and wait for
    its PUBACK before disconnecting (works with MQTT 3.1.1 and 5); or
  - with MQTT 5, disconnect with reason code **0x04, "Disconnect with Will Message"**, which tells
    the broker to publish the will anyway (ESP-IDF: set `disconnect_reason` with
    `esp_mqtt5_client_set_disconnect_property` before `esp_mqtt_client_disconnect`).

## 2. Queued commands

Every command to a queued type waits on the server. It shows as **queued** until it is sent,
**sent** until the gateway acks it, then **done** or **failed**. A queued or sent command can be
cancelled in the web app, which removes it; a gateway that already has it may still carry it out.

### 2.1 Server to gateway: `dev/{guid}/cmd/q`

```json
{"id":"8f3c2a1e","cmd":"publish_now"}
```

| Field | Meaning |
|---|---|
| `id` | the command's id, a string of up to 36 characters. The ack carries it back |
| `to` | absent: the gateway itself. A MAC: one node behind it. `"all"`: every node behind it (not wired yet, see above) |
| `cmd` | the command name, section 2.4 |
| `value` | optional; its form depends on the command |

### 2.2 Gateway to server: `dev/{guid}/cmd_ack`

```json
{"id":"8f3c2a1e","ok":true}
```

| Field | Meaning |
|---|---|
| `id` | the command's id |
| `ok` | `true` when the command was carried out everywhere it was sent |
| `results` | for commands to nodes: one entry per MAC, `"ok"`, `"no_ack"`, `"not_paired"` or `"error"`. Absent for a command to the gateway itself |
| `error` | optional short text when `ok` is `false` |

An ack without an `id` is from an unqueued type and is only logged.

### 2.3 The rules

1. **One command in flight per gateway.** The server publishes the next queued command only after
   the previous one is acked.
2. **Resent on connect.** A command sent but not acked is published again, with the **same id**,
   when the gateway next publishes its connect message.
3. **Same id, do it once.** A gateway that receives an id it has already carried out acks it again
   without carrying it out again. Keep at least the last 16 ids.
4. **Ack when done, except reboot and ota.** Ack after the command has been applied. For `reboot`,
   ack first, wait about 1 s for the ack to go out, say you are going offline (section 1), then
   reboot; otherwise the resend on connect reboots it again, forever. For `ota` to the gateway
   itself, ack once the new image is written and its MD5 checked, then say you are going offline
   and restart into it. Keep that id among the carried out ids across the restart (rule 3), so the
   resend on connect is acked again, not installed again.
5. **Unknown command:** ack with `"ok":false,"error":"unknown command"`. Never leave a command
   unacked: it blocks the queue.

### 2.4 Commands

| `cmd` | `value` | Does |
|---|---|---|
| `set_config` | `{"key":"report_secs","value":"600"}` | Sets one config key (for nodes; the gateway's own config uses `cmd/set_config/{key}`) |
| `publish_now` | none | Sends readings now |
| `reboot` | none | Acks, then reboots (rule 4) |
| `ota` | `{"url":"https://...","md5":"<32 hex>"}` | Installs the firmware at `url`, section 3 |
| `led` | `"RRGGBB"` hex, or `"off"` | Sets an LED color, for types that declare `ledColors` |

## 3. Firmware updates

The server keeps one current file per firmware image (Administration > Firmware) and queues an
`ota` command naming it. A type names its image in `firmwareImage`; the file is served at
`https://<domain>/firmware/<image>/firmware.bin`.

```json
{"id":"8f3c2a1e","cmd":"ota","value":{"url":"https://iot.example.com/firmware/<image>/firmware.bin","md5":"73d605588010c0f63cb79a6eb3e27dbe"}}
```

- **Download:** plain HTTPS GET, no login. The answer always has `Content-Length` (never chunked)
  and an `x-MD5` header, which arduino-esp32 HTTPUpdate checks the image against.
- **Upload check:** the server accepts ESP32-S3 application images only (`services/firmware.js`).
- **MD5:** the server reads the file's MD5 when the command is queued. The URL has no version in it,
  so the MD5 is what pins the exact file: if the file is replaced before the gateway downloads it,
  the check fails and the gateway keeps its current firmware. The server always sends `md5`.
- **Ack:** rule 4 in 2.3.
- **Progress:** while a transfer runs, publish on `dev/{guid}/event`, every 10 % or so:

  ```json
  {"event":"ota_progress","pct":50}
  ```

  `mac` may be added for a node being updated; the gateway's own update leaves it out. The server
  shows the percent on the Commands tab while the `ota` command is in flight.

## 4. Relayed node frames as JSON: `dev/{guid}/frame`

Besides the binary frame (base64 in `frame`), a gateway may relay a node's readings as JSON:

```json
{"mac":"A4CF12345678","rssi":-58,"model":"<model>","fw":"1.0.3","boot":12,"seq":1841,"data":{"vbat":4.02,"int_temp":24.6}}
```

| Field | Meaning |
|---|---|
| `mac` | the node's MAC |
| `rssi` | dBm, what the gateway received this message at |
| `model`, `fw` | the node's model string and firmware version |
| `boot` | the node's boot count, kept in non volatile memory, incremented at every boot |
| `seq` | per boot message counter, starting at 1 |
| `data` | the node's readings, keyed like its type's `dataMap` |

The server drops duplicates by `boot * 2^32 + seq`, so a message relayed twice counts once. Without
`boot` the counter is `seq` alone, and after a reboot the node's messages are dropped as duplicates
until `seq` passes its old value, so always send `boot` (`pipeline/identify.js` jsonFrameHeader).
