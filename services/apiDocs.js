// API and webhook documentation (DECISIONS "API and webhooks"): the one source for the API Docs and
// Webhook Docs tabs and the Download docs Markdown file. Edit the words here, not in the views.
// Site values (name, base URL, key prefix, limits) are read at call time by site(), so every site's
// copy is its own; everything else takes a site object, so it tests without config or a database.
//
// Prose uses a small inline markup shared by both outputs: `code`, **bold**, and [text](target) where
// target is #anchor, or @/path for a page under the account (a link on the page; in the Markdown file
// a link into the file when it points at an API Docs anchor, else plain text). uids in examples are
// made up.

const LOC = "3f2a9c1e-7b4d-4e21-9a0f-5c6d7e8f9a01";
const DEV = "b81c4d2e-1f3a-4c5b-8d6e-7f8091a2b3c4";
const SEN = "c92d5e3f-2a4b-4d6c-9e7f-8091a2b3c4d5";
const ALM = "d0e6f4a5-3b5c-4e7d-8f90-a1b2c3d4e5f6";

// The shell variable the examples use, from the key prefix: upper cased, anything outside A-Z 0-9
// becomes _, _KEY appended, API_ in front if it would start with a digit (voltastc -> VOLTASTC_KEY,
// no prefix -> API_KEY).
function envVarOf(keyPrefix)
{
    let v = String(keyPrefix || "api").toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_KEY";
    if (!/^[A-Z_]/.test(v)) { v = "API_" + v; }
    return v;
}

// A site object from explicit values (tests, and site() below).
function siteOf(values)
{
    const envVar = envVarOf(values.keyPrefix);
    return {
        name: values.name,
        apiBase: values.apiBase,
        keyPrefix: values.keyPrefix || null,
        envVar: envVar,
        curl: "curl -s -H \"Authorization: Bearer $" + envVar + "\" ",
        curlPost: "curl -s -X POST -H \"Authorization: Bearer $" + envVar + "\" -H \"Content-Type: application/json\" \\\n  ",
        ratePerMinute: values.ratePerMinute,
        maxObjects: values.maxObjects,
        // Voltastc sends real HTTP status codes (DECISIONS "Real HTTP status codes everywhere"); devmon's
        // always 200 middleware does not exist here. Kept so the wording stays switchable like devmon's.
        alwaysOk: !!values.alwaysOk
    };
}

// This site's values, read now.
function site()
{
    const env = require("../config/env");
    const settings = require("../config/settings");
    const apiAuth = require("./apiAuth");
    return siteOf({ name: settings.siteName(), apiBase: env.appUrl + "/api/v1", keyPrefix: apiAuth.keyPrefix(),
        ratePerMinute: settings.get("API_RATE_PER_MINUTE", 120), maxObjects: settings.get("API_MAX_OBJECTS", 1000), alwaysOk: false });
}

function endpoints(s)
{
    const CURL = s.curl;
    const CURL_POST = s.curlPost;
    const apiBase = s.apiBase;
    const maxObjects = s.maxObjects;
    const NAME = "Power in on Pod 3 at Main field";
    const RULE = "f2a3b4c5-d6e7-4f80-91a2-b3c4d5e6f708";
    const GROUP = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    const NAME_NOTE = " name is the alarm title, the same text as the email subject after the event word; it is null if the title could not be built.";

    return [
      {
        id: "locations", method: "GET", path: "/locations", perm: "View",
        about: "Every location the key can view.",
        params: [],
        example: CURL + "\"" + apiBase + "/locations\"",
        response: { locations: [{ uid: LOC, name: "Main field", timezone: "America/Chicago", membership_mode: "normal" }] }
      },
      {
        id: "devices", method: "GET", path: "/devices", perm: "View",
        about: "Live devices (not archived or deleted) in the locations the key can view.",
        params: [["location", "Optional. A location uid; only that location's devices. An unknown or hidden location returns an empty list."]],
        example: CURL + "\"" + apiBase + "/devices?location=" + LOC + "\"",
        response: { devices: [{ uid: DEV, name: "Pod 3", type: "target_accel", kind: "node", hardware_id: "A1B2C3D4E5F6", location: LOC, last_seen_epoch: 1791295200, is_offline: false }] },
        note: "kind is gateway (controller and account pods), node (target pods) or direct."
      },
      {
        id: "silent-devices", method: "GET", path: "/devices/silent", perm: "View",
        about: "Devices that have not reported for at least minutes, in one account or location: live devices that are not archived and not set offline by hand. Devices that have never reported are included, with last_seen_epoch null, unless include_never_seen is no. Longest silent first; devices that never reported come ahead of all.",
        params: [
          ["account", "An account uid: the locations in it the key can view. One of account or location is required."],
          ["location", "A location uid."],
          ["minutes", "Required. A whole number of minutes, at least 1: devices silent this long or longer. 1440 is 24 hours."],
          ["include_never_seen", "Optional. yes (the default) or no."]
        ],
        example: CURL + "\"" + apiBase + "/devices/silent?location=" + LOC + "&minutes=1440\"",
        response: { minutes: 1440, cutoff_epoch: 1791208800, devices: [{ uid: DEV, name: "Pod 3", type: "target_accel", kind: "node", hardware_id: "A1B2C3D4E5F6", location: LOC, last_seen_epoch: 1791100000, silent_secs: 195200 }] },
        note: "cutoff_epoch is now less minutes; a device last seen at or before it is listed. silent_secs is null for a device that never reported. Status 400 without account or location, or without a valid minutes. An account or location the key cannot see returns an empty list."
      },
      {
        id: "device", method: "GET", path: "/devices/<uid>", perm: "View",
        about: "One device with every sensor's latest value and alarm status. alarm_status is \"ok\" or the worst severity among active alarms (info, warning, alarm, emergency); the device's alarm_status is the worst over its sensors. active_alarms lists each active alarm, oldest first; its uid works with the alarm endpoints below. The location's alarm_mode is active, muted (alarms recorded, nobody notified) or offline (no alarms evaluated).",
        params: [],
        example: CURL + "\"" + apiBase + "/devices/" + DEV + "\"",
        response: { device: { uid: DEV, name: "Pod 3", type: "target_accel", kind: "node", hardware_id: "A1B2C3D4E5F6", model: "vpod-acc", firmware: "1.0.3",
          location: { uid: LOC, name: "Main field", timezone: "America/Chicago", alarm_mode: "active" }, last_seen_epoch: 1791295200, is_offline: false, is_archived: false, alarm_status: "alarm",
          sensors: [{ uid: SEN, device: DEV, channel: "vin", name: "Power in", metric: "voltage", canonical_unit: "V", display_unit: "V", is_hidden: false, last_value: 0.4, last_display: "0.40 V", last_epoch: 1791295200,
            alarm_status: "alarm", active_alarms: [{ uid: ALM, severity: "alarm", direction: "lower", raised_epoch: 1791294000, acknowledged: false, ack_until_epoch: null, suppressed: false, trigger_value: 0.4 }] }] } },
        note: "Values and trigger_value are in the canonical unit; last_display is in the display unit. Status 404 when the device does not exist or the key may not view it."
      },
      {
        id: "sensors", method: "GET", path: "/sensors", perm: "View",
        about: "Sensors with their latest value. last_value is in the canonical unit; last_display is formatted in the display unit the pages use.",
        params: [["device", "Optional. A device uid; only that device's sensors. An unknown or malformed uid returns an empty list."]],
        example: CURL + "\"" + apiBase + "/sensors?device=" + DEV + "\"",
        response: { sensors: [{ uid: SEN, device: DEV, channel: "vin", name: "Power in", metric: "voltage", canonical_unit: "V", display_unit: "V", last_value: 12.1, last_display: "12.10 V", last_epoch: 1791295200 }] }
      },
      {
        id: "sensor", method: "GET", path: "/sensors/<uid>", perm: "View",
        about: "One sensor's latest value and alarm status, with its device and location.",
        params: [],
        example: CURL + "\"" + apiBase + "/sensors/" + SEN + "\"",
        response: { sensor: { uid: SEN, device: DEV, channel: "vin", name: "Power in", metric: "voltage", canonical_unit: "V", display_unit: "V", is_hidden: false, last_value: 12.1, last_display: "12.10 V", last_epoch: 1791295200,
          alarm_status: "ok", active_alarms: [], device_name: "Pod 3", location: { uid: LOC, name: "Main field", timezone: "America/Chicago", alarm_mode: "active" } } },
        note: "Status 404 when the sensor does not exist or the key may not view it."
      },
      {
        id: "readings", method: "GET", path: "/readings", perm: "View",
        about: "Stored readings for one sensor between two epochs, oldest first, as stored (never averaged or thinned). Each reading has the canonical value and the value in the display unit.",
        params: [
          ["sensor", "Required. The sensor uid."],
          ["from", "Optional. Start, epoch seconds. Default: 24 hours before to."],
          ["to", "Optional. End, epoch seconds. Default: now."],
          ["limit", "Optional. Most rows per reply, default 5000, at most 20000. When there are more, truncated is true: ask again with from set to next_from, and repeat until truncated is false. Nothing is skipped or repeated, unless more than limit readings share one second: then that second is cut at limit and next_from moves past it, so keep limit well above one second's worth."]
        ],
        example: CURL + "\"" + apiBase + "/readings?sensor=" + SEN + "&from=1791208800&to=1791295200\"",
        response: { sensor: SEN, metric: "voltage", canonical_unit: "V", display_unit: "V", from: 1791208800, to: 1791295200, truncated: false, next_from: null, readings: [{ epoch: 1791208860, value: 12.1, display_value: 12.1 }, { epoch: 1791209160, value: 12.08, display_value: 12.08 }] },
        note: "Status 404 when the sensor does not exist, is missing from the request or the key may not view it."
      },
      {
        id: "post-readings", method: "POST", path: "/readings", perm: "API write",
        about: "Send single readings by sensor uid, for direct devices (devices that report over the API rather than through a pod or gateway) whose device type accepts API readings. To send a device's readings by channel, or a batch, use POST /devices/<uid>/readings. The body is an array, or { \"readings\": [...] }. Each item names a sensor uid and a value; unit is optional and defaults to the metric's canonical unit; epoch is optional and defaults to now, may be in the past, and may not be more than 5 minutes in the future. At most " + maxObjects + " items per request. Accepted values go through the same pipeline as pod data, so alarm rules apply.",
        params: [],
        example: CURL_POST + "-d '[{ \"sensor\": \"" + SEN + "\", \"value\": 12.1, \"unit\": \"V\", \"epoch\": 1791295200 }]' \\\n  \"" + apiBase + "/readings\"",
        response: { accepted: 1, rejected: [] },
        note: "Items that fail are listed with their position: { \"index\": 3, \"error\": \"only direct devices accept API readings\" }. A reading for a device whose type does not accept API readings is rejected the same way. Status 400 when the body is not an array of readings, 413 when it has too many, 422 when nothing is accepted."
      },
      {
        id: "device-readings", method: "POST", path: "/devices/<uid>/readings", perm: "API write",
        about: "Send readings for one device by channel: the usual way to upload, and the one for a batch of buffered readings. Only devices whose type accepts API readings take them; pods do not, their data comes only from the pods themselves. The body is one object or an array of them, each { \"epoch\": optional, \"data\": { channel: value, ... } }. Channels are the device type's channel ids (as on the device's sensors, for example vin or int-temp). Values are numbers (or true and false) in the canonical unit. epoch defaults to now, may be in the past, and may not be more than 5 minutes in the future. At most " + maxObjects + " objects per request. The whole request is checked before anything is stored. A sensor appears with its channel's first value. A channel that already has a reading at that epoch is counted as deduped and not stored again, so a retried upload is safe. Accepted values go through the same pipeline as pod data, so alarm rules apply.",
        params: [],
        example: CURL_POST + "-d '[{ \"epoch\": 1791295140, \"data\": { \"vin\": 12.1, \"int-temp\": 24.5 } }, { \"epoch\": 1791295200, \"data\": { \"vin\": 12.08 } }]' \\\n  \"" + apiBase + "/devices/" + DEV + "/readings\"",
        response: { device: DEV, accepted: 3, deduped: 0, results: [{ index: 0, epoch: 1791295140, accepted: 2, deduped: [], skipped: [] }, { index: 1, epoch: 1791295200, accepted: 1, deduped: [], skipped: [] }] },
        note: "Status 400 when a channel is unknown (the reply lists valid_channels), a value is not a number, data is missing or an epoch is too far ahead; index names the object, and nothing is stored. 413 when there are too many objects, 404 when the device does not exist, is archived or the key may not write to it, 403 when the device's type does not accept API readings. skipped lists channels the device has but does not take now (a disabled sensor)."
      },
      {
        id: "active-alarms", method: "GET", path: "/alarms/active", perm: "View",
        about: "Alarms that are active now, in one account, location, device or sensor." + NAME_NOTE,
        params: [
          ["account", "Alarms in every location of the account that the key can view (account uid). One of account, location, device or sensor is required; given together they narrow each other."],
          ["location", "This location's alarms (location uid)."],
          ["device", "This device's alarms (device uid)."],
          ["sensor", "This sensor's alarms (sensor uid)."]
        ],
        example: CURL + "\"" + apiBase + "/alarms/active?location=" + LOC + "\"",
        response: { alarms: [{ uid: ALM, name: NAME, severity: "alarm", direction: "lower", raised_epoch: 1791294000, acknowledged: false, suppressed: false, sensor: SEN, sensor_name: "Power in", device: DEV, device_name: "Pod 3", location: LOC, trigger_value: 0.4 }] },
        note: "trigger_value is in the canonical unit. direction is upper, lower or no_data. Status 400 without account, location, device or sensor; one the key cannot see returns an empty list."
      },
      {
        id: "alarm-history", method: "GET", path: "/alarms/history", perm: "View",
        about: "Alarms raised between from and to, oldest first, whether still active or cleared, including alarms of sensors and devices deleted since. severity is the alarm's current severity (its last one, once cleared); highest_severity is the worst it reached. duration_secs runs to cleared_epoch, or to now while the alarm is active. clear_reason says why it cleared, for example returned, manual, offline, disarmed, archived or sensor_deleted." + NAME_NOTE,
        params: [
          ["from", "Optional. Start, epoch seconds, matched against raised_epoch. Default: 24 hours before to."],
          ["to", "Optional. End, epoch seconds. Default: now."],
          ["location", "This location's alarms (location uid). One of location, device or sensor is required; given together they narrow each other."],
          ["device", "This device's alarms (device uid)."],
          ["sensor", "This sensor's alarms (sensor uid)."],
          ["limit", "Optional. Most alarms per reply, default 500, at most 1000. Paged like readings: while truncated is true, ask again with from set to next_from."]
        ],
        example: CURL + "\"" + apiBase + "/alarms/history?from=1790690400&to=1791295200&location=" + LOC + "\"",
        response: { from: 1790690400, to: 1791295200, truncated: false, next_from: null, alarms: [{ uid: ALM, name: NAME, sensor: SEN, sensor_name: "Power in", device: DEV, device_name: "Pod 3", location: LOC,
          direction: "lower", severity: "warning", highest_severity: "alarm", raised_epoch: 1791294000, cleared_epoch: 1791297600, is_active: false, duration_secs: 3600, clear_reason: "returned",
          acknowledged: true, suppressed: false, trigger_value: 0.4, canonical_unit: "V" }] },
        note: "trigger_value is in canonical_unit. A filter that names nothing the key can see returns an empty list. Each uid works with the alarm endpoints."
      },
      {
        id: "alarm-detail", method: "GET", path: "/alarms/<uid>", perm: "View",
        about: "Everything about one alarm, as its page shows it: where it is, the rule that set its severity, every event from raised to cleared with who did it and the notifications each event sent, and the alert group escalation ladders. Values are canonical; the *_display fields are in the display unit." + NAME_NOTE,
        params: [],
        example: CURL + "\"" + apiBase + "/alarms/" + ALM + "\"",
        response: { alarm: { uid: ALM, name: NAME, direction: "lower", severity: "alarm", highest_severity: "alarm", raised_epoch: 1791294000, cleared_epoch: 1791297600, is_active: false, duration_secs: 3600, clear_reason: "manual",
          acknowledged: true, acked_epoch: 1791294300, acked_by: "jseese", ack_until_epoch: 1791297900, suppressed: false, trigger_value: 0.4, trigger_display: "0.40 V", canonical_unit: "V", display_unit: "V",
          sensor: { uid: SEN, name: "Power in", channel: "vin", metric: "voltage" }, device: { uid: DEV, name: "Pod 3" },
          location: { uid: LOC, name: "Main field", timezone: "America/Chicago" }, account: { uid: "e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7", name: "Volta" },
          rule: { uid: RULE, kind: "threshold", direction: "lower", threshold: 10, threshold_display: "10.00 V", severity: "alarm", exceed_secs: 300, return_secs: 300, timeout_secs: null, is_enabled: true, is_deleted: false },
          events: [
            { epoch: 1791294000, kind: "raised", severity: "alarm", value: 0.4, value_display: "0.40 V", comment: null, actor: { type: "system", name: null },
              notifications: [{ epoch: 1791294001, channel: "email", outcome: "sent", reason: null, to: "coaches@example.com", recipient_type: "user", ladder: "level 1 of Coaches", subject: "ALARM: " + NAME }] },
            { epoch: 1791294300, kind: "acknowledged", severity: null, value: null, value_display: null, comment: "Pod unplugged for cleaning", actor: { type: "user", name: "jseese" }, notifications: [] },
            { epoch: 1791297600, kind: "cleared", severity: "alarm", value: null, value_display: null, comment: "Power restored", actor: { type: "api_credential", name: "Scoreboard" }, notifications: [] }
          ],
          escalations: [{ alert_group: GROUP, alert_group_name: "Coaches", level: 1, level_entered_epoch: 1791294000, is_stopped: true }] } },
        note: "Event kinds: raised, escalated, de_escalated, acknowledged, ignored, cleared, re_notified, suppressed. An actor is a user, an API key (api_credential) or the system. Notification outcome is sent, failed or suppressed, with the reason when it was not sent; message bodies are not included. rule is null when no rule set the severity; is_deleted is true when that rule has since been removed. Status 404 when the alarm does not exist or the key may not view it."
      },
      {
        id: "ack", method: "POST", path: "/alarms/<uid>/ack", perm: "Acknowledge alarms",
        about: "Acknowledge an active alarm, which stops its notifications for a while.",
        params: [["comment", "Required, in the JSON body. Up to 500 characters."], ["minutes", "Optional, in the JSON body. How long the acknowledgement lasts, 5 to 1440. Default 60."]],
        example: CURL_POST + "-d '{ \"comment\": \"Pod unplugged for cleaning\", \"minutes\": 60 }' \\\n  \"" + apiBase + "/alarms/" + ALM + "/ack\"",
        response: { ok: true },
        note: "Status 404 when the alarm does not exist or the key may not acknowledge it, 400 when comment is missing, 409 when the alarm is already cleared."
      },
      {
        id: "clear", method: "POST", path: "/alarms/<uid>/clear", perm: "Clear alarms",
        about: "Clear an active alarm by hand.",
        params: [["comment", "Required, in the JSON body. Up to 500 characters."]],
        example: CURL_POST + "-d '{ \"comment\": \"Power restored\" }' \\\n  \"" + apiBase + "/alarms/" + ALM + "/clear\"",
        response: { ok: true },
        note: "Same statuses as acknowledge."
      },
      {
        id: "rules", method: "GET", path: "/alarm-rules", perm: "View",
        about: "The alarm rules (limits) in force now. kind is threshold (direction upper or lower, threshold in the canonical unit, exceed_secs past the limit before it raises, return_secs back inside before it clears) or no_data (timeout_secs without a reading). channel_policy says which transitions (raise, escalate, de_escalate, clear) send email and SMS. use_default_group means the account's default alert group is notified as well as alert_groups. alarm_title is the rule's own title template, or null when it uses the sensor's or a wider one.",
        params: [["location", "This location's rules (location uid). One of location, device or sensor is required; given together they narrow each other."], ["device", "This device's rules (device uid)."], ["sensor", "This sensor's rules (sensor uid)."]],
        example: CURL + "\"" + apiBase + "/alarm-rules?sensor=" + SEN + "\"",
        response: { rules: [{ uid: RULE, sensor: SEN, sensor_name: "Power in", device: DEV, device_name: "Pod 3", location: LOC, kind: "threshold", direction: "lower",
          threshold: 10, threshold_display: "10.00 V", canonical_unit: "V", display_unit: "V", severity: "alarm", exceed_secs: 300, return_secs: 300, timeout_secs: null, is_enabled: true, use_default_group: true,
          channel_policy: { raise: { email: true, sms: false }, escalate: { email: true, sms: false }, de_escalate: { email: true, sms: false }, clear: { email: true, sms: false } }, alarm_title: null,
          alert_groups: [{ uid: GROUP, name: "Coaches" }], created_epoch: 1790000000 }] },
        note: "channel_policy is null for a rule never saved from its form; it then sends on every channel. Status 400 without location, device or sensor; one that names nothing the key can see returns an empty list. Each rule's uid is what GET /alarm-rules/changes takes."
      },
      {
        id: "rule-changes", method: "GET", path: "/alarm-rules/changes", perm: "View",
        about: "Every change to one alarm rule between from and to, oldest first: who made it and what it was before and after. change is created or deleted (new_value or old_value holds the whole rule), or the name of the field that changed: rule_kind, direction, threshold, severity, exceed_secs, return_secs, timeout_secs, is_enabled, use_default_group, channel_policy, alert_groups or alarm_title. Values are canonical; old_display and new_display are worded as the sensor's Alarm rules page words them. Deleted rules, sensors and devices are included, so a removed limit still shows who removed it.",
        params: [
          ["from", "Optional. Start, epoch seconds. Default: the rule's first change."],
          ["to", "Optional. End, epoch seconds. Default: now."],
          ["rule", "Required. The rule's uid, from GET /alarm-rules."],
          ["limit", "Optional. Most changes per reply, default 500, at most 1000. Paged like readings: while truncated is true, ask again with from set to next_from."]
        ],
        example: CURL + "\"" + apiBase + "/alarm-rules/changes?rule=" + RULE + "&from=1790690400\"",
        response: { from: 1790690400, to: 1791295200, truncated: false, next_from: null, changes: [
          { epoch: 1791200000, rule: RULE, sensor: SEN, sensor_name: "Power in", device: DEV, device_name: "Pod 3", location: LOC,
            change: "threshold", old_value: 9, new_value: 10, old_display: "9.00 V", new_display: "10.00 V", actor: { type: "user", name: "jseese" } },
          { epoch: 1791200400, rule: RULE, sensor: SEN, sensor_name: "Power in", device: DEV, device_name: "Pod 3", location: LOC,
            change: "alert_groups", old_value: null, new_value: "Coaches", old_display: "none", new_display: "Coaches", actor: { type: "user", name: "jseese" } }
        ] },
        note: "In created and deleted rows the whole rule comes back as an object with typed values, plus reason when the system made the change: { \"rule_kind\": \"threshold\", \"direction\": \"lower\", \"threshold\": 10, \"is_enabled\": true, ..., \"reason\": \"sensor deleted\" }. actor type is user, api_credential or system (rules a device type adds when a sensor first reports). Rules removed along with a deleted sensor or device carry the reason in the deleted row; rules of a deleted location are no longer visible to any key."
      }
    ];
}

// The calls for one page's API tab (DECISIONS "API tabs"): ready to run commands with the page's real
// uids. The method, path, permission and docs anchor of each come from endpoints() above. page is one of
//   { kind: "device", device: { uid, apiWrite, channels: [channel ids] }, sensors: [{ uid, name }] }
//   { kind: "sensor", sensor: { uid, channel }, device: { uid, apiWrite }, rules: [{ uid, label }] }
//   { kind: "location-alarms", location: { uid }, account: { uid } or null }
//   { kind: "location-devices", location: { uid } }
//   { kind: "alarm", alarm: { uid, active } }
// Returns { intro, calls: [{ docs, method, path, perm, about, example }] }.
function pageCalls(s, page)
{
    const ref = new Map(endpoints(s).map((e) => [e.id, e]));
    const base = s.apiBase;
    const line = (path) => s.curl + "\"" + base + path + "\"";
    const oneLine = (v) => String(v).replace(/[\r\n]+/g, " ");
    const out = [];
    function call(id, about, example)
    {
        const e = ref.get(id);
        out.push({ docs: id, method: e.method, path: e.path, perm: e.perm, about: about, example: example });
    }
    function post(id, about, body, path)
    {
        call(id, about, s.curlPost + "-d '" + JSON.stringify(body) + "' \\\n  \"" + base + path + "\"");
    }
    function sample(channels)
    {
        const data = {};
        channels.slice(0, 2).forEach((c) => { data[c] = 0; });
        return { data: data };
    }

    if (page.kind === "device")
    {
        const d = page.device.uid;
        call("device", "This device with every sensor's latest value and alarm status.", line("/devices/" + d));
        call("sensors", "This device's sensors with their latest values.", line("/sensors?device=" + d));
        if (page.sensors.length)
        {
            call("readings", "Stored readings, one sensor per call: the last 24 hours, or add from and to (epoch seconds).",
                page.sensors.map((x) => "# " + oneLine(x.name) + "\n" + line("/readings?sensor=" + x.uid)).join("\n"));
        }
        call("active-alarms", "This device's active alarms.", line("/alarms/active?device=" + d));
        call("alarm-history", "Alarms raised on this device: the last 24 hours, or add from and to.", line("/alarms/history?device=" + d));
        call("rules", "The alarm rules on this device's sensors. A rule's uid gives its change log.", line("/alarm-rules?device=" + d));
        if (page.device.apiWrite && page.device.channels.length)
        {
            post("device-readings", "Send readings to this device by channel. Its channels: " + page.device.channels.join(", ") + ".", sample(page.device.channels), "/devices/" + d + "/readings");
        }
    }
    else if (page.kind === "sensor")
    {
        const x = page.sensor.uid;
        call("sensor", "This sensor's latest value and alarm status.", line("/sensors/" + x));
        call("readings", "Stored readings for this sensor: the last 24 hours, or add from and to (epoch seconds).", line("/readings?sensor=" + x));
        call("active-alarms", "This sensor's active alarms.", line("/alarms/active?sensor=" + x));
        call("alarm-history", "Alarms raised on this sensor: the last 24 hours, or add from and to.", line("/alarms/history?sensor=" + x));
        call("rules", "This sensor's alarm rules.", line("/alarm-rules?sensor=" + x));
        if (page.rules.length)
        {
            call("rule-changes", "Each rule's change log, one rule per call, from its first change.",
                page.rules.map((r) => "# " + oneLine(r.label) + "\n" + line("/alarm-rules/changes?rule=" + r.uid)).join("\n"));
        }
        if (page.device.apiWrite)
        {
            post("device-readings", "Send a reading for this sensor, through its device.", sample([page.sensor.channel]), "/devices/" + page.device.uid + "/readings");
        }
    }
    else if (page.kind === "location-devices")
    {
        const l = page.location.uid;
        call("devices", "Every live device at this location, gateways and pods alike (kind tells them apart), with its last seen time.", line("/devices?location=" + l));
        call("silent-devices", "Devices here with no data for 24 hours or more; change minutes for another span.", line("/devices/silent?location=" + l + "&minutes=1440"));
    }
    else if (page.kind === "location-alarms")
    {
        const l = page.location.uid;
        call("active-alarms", "Alarms active now at this location.", line("/alarms/active?location=" + l));
        if (page.account) { call("active-alarms", "Alarms active now in every location of the account that the key can view.", line("/alarms/active?account=" + page.account.uid)); }
        call("alarm-history", "Alarms raised at this location: the last 24 hours, or add from and to (epoch seconds).", line("/alarms/history?location=" + l));
        call("rules", "The alarm rules at this location.", line("/alarm-rules?location=" + l));
        call("rule-changes", "One rule's change log, from its first change. Put a rule's uid from the call above in place of <rule uid>.", line("/alarm-rules/changes?rule=<rule uid>"));
        call("silent-devices", "Devices here with no data for 24 hours or more; change minutes for another span.", line("/devices/silent?location=" + l + "&minutes=1440"));
    }
    else if (page.kind === "alarm")
    {
        const a = page.alarm.uid;
        call("alarm-detail", "This alarm with its events, notifications and escalations.", line("/alarms/" + a));
        if (page.alarm.active)
        {
            post("ack", "Acknowledge this alarm: its notifications stop for minutes (5 to 1440).", { comment: "Checked on site", minutes: 60 }, "/alarms/" + a + "/ack");
            post("clear", "Clear this alarm by hand.", { comment: "Fixed on site" }, "/alarms/" + a + "/clear");
        }
    }
    const intro = "Each command is ready to run with this page's uids. Put your API key in $" + s.envVar + " first (export " + s.envVar + "=<your key>). "
        + "Keys are made in Account > API; parameters and replies are in API Docs.";
    return { intro: intro, calls: out };
}

const PERMISSIONS =
[
    ["View", "Read locations, devices, sensors, readings, alarms, alarm rules and the rule change log."],
    ["API write", "Send readings: by device and channel, or by sensor for direct devices."],
    ["Acknowledge alarms", "Acknowledge active alarms."],
    ["Clear alarms", "Clear active alarms by hand."]
];

// The prose of both pages, built for this site.
function text(s)
{
    return {
        keyIntro: "Each program that uses the API gets its own key. A key belongs to one account and only sees that account's locations.",
        keySteps:
        [
            "Open the [API Keys](@/api) tab (Account > API).",
            "Under API credentials, give the key a name that says who uses it, for example \"Scoreboard\".",
            "Optionally set Expires (days). Leave it blank for a key that does not expire.",
            "Tick the permissions the program needs, and no more (see [Permissions](#permissions)). You can only give a key permissions you hold yourself.",
            "Click Create key and copy the key from the green box. It is shown once and never stored; if it is lost, revoke it and create a new one."
        ],
        keyAfter: "Revoke stops a key at once. Last used shows when each key was last seen.",
        keyWho: "Creating a key needs the **Manage users** permission on the account.",
        noPrefix: "Keys cannot be created on this server yet: the site administrator has to set API_KEY_PREFIX in Admin > Site settings > API.",
        requestIntro: "Base URL: `" + s.apiBase + "`. HTTPS only. Send the key as a bearer token on every request:",
        authLine: "Authorization: Bearer " + (s.keyPrefix || "prefix") + "_1a2b3c4d_...",
        shellIntro: "Examples below keep the key in a shell variable so it stays out of your history:",
        shell: "export " + s.envVar + "='paste the key here'\n" + s.curl + "\"" + s.apiBase + "/locations\"",
        requestNotes:
        [
            "Requests and replies are JSON. Send `Content-Type: application/json` with a POST body.",
            "Times are epoch seconds (UTC) everywhere, in and out.",
            "Things are identified by uid: the same uid that appears in the page's address bar, for example `/sensors/" + SEN + "`.",
            "Values are stored in a canonical unit per metric (for example C for temperature). Replies give the canonical value and, where useful, the value in the display unit the pages use.",
            "Each key may make " + s.ratePerMinute + " requests per minute. Every reply to an accepted key carries `x-ratelimit-limit` and `x-ratelimit-remaining`; past the limit you get status 429 with `retry_after_secs`."
        ],
        replyIntro: s.alwaysOk
            ? "**Every reply comes back as HTTP 200**, errors included, because the web server in front of this site replaces the body of any error reply. The real status is in the `x-app-status` header and in the body. Check those, not the HTTP status."
            : "The HTTP status code is the real one: 200 means success, anything else is an error with a JSON body naming it.",
        replySample: s.alwaysOk ? { ok: false, status: 401, error: "Invalid or expired token" } : { error: "Invalid or expired token" },
        statuses:
        [
            s.alwaysOk ? ["(none)", "Success. No `x-app-status` header and no `ok: false`."] : ["200", "Success."],
            ["400", "The request is missing something or is malformed; `error` says what."],
            ["401", "No key, a revoked or expired key, or a mistyped key."],
            ["403", "The device's type does not accept API readings."],
            ["404", "Not found. Also what you get for something the key may not see or do: the API does not say which. An unknown path answers `Unknown endpoint`."],
            ["409", "The action no longer applies, for example acknowledging a cleared alarm."],
            ["413", "Too many items in one request."],
            ["422", "Nothing in the request could be accepted."],
            ["429", "Rate limit reached; wait `retry_after_secs`."],
            ["500", "A fault on our side. The body carries a `reference`; quote it in a support request."]
        ],
        permissionsIntro: "A key holds permissions on its account, chosen when it is created. Each endpoint says which one it needs.",

        hookIntro: "A webhook sends events to your URL as they happen, instead of your program asking the [API](@/api/docs). Each webhook belongs to one account and receives events from all of its locations.",
        hookSteps:
        [
            "Open the [Webhooks](@/webhooks) tab (Account > Webhooks).",
            "Give the webhook a name and the http(s) URL that will receive the events.",
            "Pick the events: readings, alarm transitions or both.",
            "Click Add webhook and copy the signing secret from the green box. It is shown once; if it is lost, remove the webhook and add it again."
        ],
        hookAfter: "Pause stops deliveries without removing the webhook. A new or resumed webhook starts receiving events within a minute.",
        hookWho: "Adding a webhook needs the **Edit** permission on the account.",
        headersIntro: "Each event is a POST with a JSON body and these headers:",
        headers:
        [
            "`x-voltastc-event`: `reading` or `alarm`",
            "`x-voltastc-delivery`: a delivery number, the same on every retry of one event",
            "`x-voltastc-signature`: `sha256=` followed by the HMAC SHA-256 of the raw body, keyed with the signing secret, in hex"
        ],
        retries: "Reply with any 2xx status within 10 seconds. Anything else is retried after 1, 5, 30 and 120 minutes, then marked failed. Deliveries still waiting when a webhook is paused or removed are marked failed. The Recent column on the Webhooks tab shows the last five deliveries.",
        readingSample: { event: "reading", device: DEV, epoch: 1791295200, readings: [{ sensor: SEN, channel: "vin", metric: "voltage", value: 12.1, epoch: 1791295200 }] },
        readingText: "Values are in the canonical unit. Use the device and sensor uids with the API.",
        alarmSample: { event: "alarm", device: DEV, epoch: 1791294000, alarm: ALM, sensor: SEN, direction: "lower", kind: "raised", severity: "alarm" },
        alarmText: "`kind` is raised, escalated, de_escalated, cleared or suppressed; `direction` is upper, lower or no_data. Use the alarm uid with the [alarm endpoints](@/api/docs#alarm-detail) for the whole story, including its title.",
        alarmGap: "Alarm events are sent only for changes caused by incoming readings. These do not send one yet: no data alarms, acknowledgements, alarms cleared by hand or by the API, and alarms cleared because a location went offline or a device was archived or deleted.",
        signatureIntro: "Check every delivery before trusting it. In Node.js:",
        signatureCode: [
            "const crypto = require(\"crypto\");",
            "",
            "// rawBody is the request body exactly as received, before JSON parsing.",
            "function isGenuine(rawBody, signatureHeader, secret)",
            "{",
            "    const expected = \"sha256=\" + crypto.createHmac(\"sha256\", secret).update(rawBody).digest(\"hex\");",
            "    const a = Buffer.from(expected);",
            "    const b = Buffer.from(String(signatureHeader || \"\"));",
            "    return a.length === b.length && crypto.timingSafeEqual(a, b);",
            "}"
        ].join("\n")
    };
}

// Everything both pages and the download need. s defaults to this site's values.
function build(s)
{
    const st = s || site();
    return { site: st, endpoints: endpoints(st), permissions: PERMISSIONS, t: text(st) };
}

function escapeHtml(v)
{
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Inline markup to HTML for the pages: escaped first, then marked up. acctBase resolves @/ links.
function html(str, acctBase)
{
    let out = escapeHtml(str);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, target) => "<a href=\"" + (target.startsWith("@") ? acctBase + target.slice(1) : target) + "\">" + label + "</a>");
    return out;
}

// Inline markup to Markdown. The file has no account: a link to an API Docs anchor becomes a link
// into the file, any other account page link becomes its label.
function md(str)
{
    return String(str).replace(/\[([^\]]+)\]\(@([^)]*)\)/g, (m, label, target) =>
    {
        const hash = target.indexOf("#");
        return target.startsWith("/api/docs#") && hash >= 0 ? "[" + label + "](" + target.slice(hash) + ")" : label;
    });
}

// <uid> in a path would be read as an HTML tag by Markdown viewers outside code.
function angle(v)
{
    return String(v).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fence(body, lang)
{
    return "```" + (lang || "") + "\n" + body + "\n```";
}

function table(head, rows)
{
    const cell = (v) => md(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
    return "| " + head.join(" | ") + " |\n| " + head.map(() => "---").join(" | ") + " |\n" + rows.map((r) => "| " + r.map(cell).join(" | ") + " |").join("\n");
}

// The whole of both pages as one Markdown file. Generic: nothing about the viewer or the account;
// where a page says what the viewer can do, the file states the permission needed.
function markdown(s)
{
    const d = build(s);
    const st = d.site;
    const t = d.t;
    const date = new Date().toISOString().slice(0, 10);
    const out = [];
    out.push("# " + st.name + " API and webhooks");
    out.push("Generated " + date + " for `" + st.apiBase + "`. Check the API Docs page on the site for the current version.");
    out.push("## Contents\n\n" + ["Getting a key", "Making requests", "Replies and errors", "Permissions"].map((h) => "- [" + h + "](#" + h.toLowerCase().replace(/ /g, "-") + ")").join("\n")
        + "\n- [Endpoints](#endpoints)\n" + d.endpoints.map((e) => "  - [" + e.method + " " + angle(e.path) + "](#" + e.id + ")").join("\n")
        + "\n- [Webhooks](#webhooks)\n  - [Deliveries](#deliveries)\n  - [Events](#events)\n  - [Checking the signature](#checking-the-signature)");

    const keyNote = st.keyPrefix ? "" : "\n\n" + t.noPrefix;
    out.push("## Getting a key\n\n" + t.keyIntro + " " + md(t.keyWho) + keyNote + "\n\n" + t.keySteps.map((x, i) => (i + 1) + ". " + md(x)).join("\n") + "\n\n" + t.keyAfter);
    out.push("## Making requests\n\n" + md(t.requestIntro) + "\n\n" + fence(t.authLine) + "\n\n" + t.shellIntro + "\n\n" + fence(t.shell, "sh") + "\n\n" + t.requestNotes.map((x) => "- " + md(x)).join("\n"));
    out.push("## Replies and errors\n\n" + md(t.replyIntro) + "\n\n" + fence(JSON.stringify(t.replySample, null, 2), "json") + "\n\n" + table(["Status", "Meaning"], t.statuses));
    out.push("## Permissions\n\n" + t.permissionsIntro + "\n\n" + table(["Permission", "Lets the key"], d.permissions));

    out.push("## Endpoints");
    for (const e of d.endpoints)
    {
        const parts = ["<a id=\"" + e.id + "\"></a>\n### " + e.method + " " + angle(e.path), "Needs **" + e.perm + "**.", angle(e.about)];
        if (e.params.length) { parts.push(table(["Parameter", "Meaning"], e.params.map((p) => ["`" + p[0] + "`", angle(p[1])]))); }
        parts.push("Example:\n\n" + fence(e.example, "sh"));
        parts.push("Reply:\n\n" + fence(JSON.stringify(e.response, null, 2), "json"));
        if (e.note) { parts.push(angle(e.note)); }
        out.push(parts.join("\n\n"));
    }

    out.push("## Webhooks\n\n" + md(t.hookIntro) + " " + md(t.hookWho) + "\n\n" + t.hookSteps.map((x, i) => (i + 1) + ". " + md(x)).join("\n") + "\n\n" + t.hookAfter);
    out.push("### Deliveries\n\n" + t.headersIntro + "\n\n" + t.headers.map((x) => "- " + md(x)).join("\n") + "\n\n" + t.retries);
    out.push("### Events\n\nA reading event:\n\n" + fence(JSON.stringify(t.readingSample, null, 2), "json") + "\n\n" + md(t.readingText)
        + "\n\nAn alarm event:\n\n" + fence(JSON.stringify(t.alarmSample, null, 2), "json") + "\n\n" + md(t.alarmText) + " " + t.alarmGap);
    out.push("### Checking the signature\n\n" + t.signatureIntro + "\n\n" + fence(t.signatureCode, "js"));
    return out.join("\n\n") + "\n";
}

// File name for the download: the site name made safe, then -api.md.
function fileName(name)
{
    const n = name === undefined ? site().name : name;
    const base = String(n || "site").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
    return base + "-api.md";
}

// Where the Download docs button points, under the account.
function downloadPath(acctBase)
{
    return acctBase + "/api/docs/download";
}

module.exports = { envVarOf, siteOf, site, build, pageCalls, html, markdown, fileName, downloadPath };
