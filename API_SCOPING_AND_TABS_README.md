# Scoped alarm API, silent devices, API tabs and alarm page tabs: port guide

Built and settled on voltastc (Oct 2026). Four related changes, written to be handed to Claude (or a
developer) working in the target repo as the spec for the work. The target is the devmon / DTM
family of sites on Windows and IIS. Port `API_WRITE_FLAG_README.md` first: the API tabs show write
calls only for device types with `apiWrite`.

## How to use this document

1. Read the target site's decisions log, structure notes, `routes/api.js`, `services/apiDocs.js`,
   `services/apiHelpers.js`, `routes/alarms.js`, `routes/devices.js`, `routes/sensors.js`,
   `routes/locations.js` and `nav/menu.js` first. Map every name below to the site's own. Where the
   site has settled something that conflicts, stop and ask; do not overwrite it.
2. Do the audit below before changing the API. Part 1 is a breaking change.
3. Agree a plan, then build in the order at the end. Record each part in the decisions log.

## The audit (do this first)

On voltastc nothing called the alarm endpoints yet, so requiring a scope broke nobody. The target
may have customers on the API. Search the event log or request log for calls to
`/api/v1/alarms/active`, `/api/v1/alarms/history`, `/api/v1/alarm-rules` and
`/api/v1/alarm-rules/changes` over a long window, with their query strings and which keys made them.
Report to Jeff any caller that sends no scope (or, for the change log, no `rule`) before shipping
part 1. Also note which of these endpoints the target has at all; build only what exists or what
Jeff asks for.

## Part 1: alarm queries are scoped

Every alarm list names what it covers. A request without a scope is a 400, checked before anything
is read.

| Endpoint | Required, one of |
|---|---|
| `GET /alarms/history` | `location`, `device`, `sensor` |
| `GET /alarms/active` | `account`, `location`, `device`, `sensor` |
| `GET /alarm-rules` | `location`, `device`, `sensor` |
| `GET /alarm-rules/changes` | `rule` (the location, device and sensor filters are removed here) |
| `GET /alarms/<uid>` | no scope; it is one alarm |

- Filters given together narrow each other. A malformed uid, or one that names nothing the key can
  see, is an empty list as before (not a 400, not a 404).
- `account` on active alarms is the one account wide alarm list: every location of that account the
  key can view. It is new code (`accountLocationIds(uid, locs)`): malformed uid or unknown account or
  no visible locations gives null and an empty list.
- Assets are devices, so `device` covers them.
- The rule change log is one rule's history, and with `rule` given it starts from the rule's first
  change unless `from` is given. The caller lists rules with
  `GET /alarm-rules` to get a rule uid.
- voltastc already had `applyScopeFilters(req, q, locs)` (location, device, sensor on a query joined
  as `d` and `s`) on history, rules and changes; active alarms had no filters and now uses it.

The required check is a pure helper in `services/apiHelpers.js`:

```js
// The scope a list endpoint requires: at least one of allowed must be given. Returns the error text
// for the 400, or null when one is present.
function missingScope(query, allowed)
{
    const q = query || {};
    if (allowed.some((k) => q[k] !== undefined && q[k] !== null && String(q[k]) !== "")) { return null; }
    if (allowed.length === 1) { return allowed[0] + " is required (a uid)."; }
    return "One of " + allowed.slice(0, -1).join(", ") + " or " + allowed[allowed.length - 1] + " is required (a uid).";
}
```

Each route starts with:

```js
const scopeErr = missingScope(req.query, ["location", "device", "sensor"]);
if (scopeErr) { return res.status(400).json({ error: scopeErr }); }
```

## Part 2: silent devices

`GET /devices/silent?location=<uid>&minutes=1440` (or `account=<uid>`; one is required), View.

- Devices that have not reported for at least `minutes`: `last_seen_epoch <= now - minutes * 60`.
- Live devices only: not deleted, not archived, not set offline by hand (those are known quiet).
- A device that never reported matches every duration and is listed with `last_seen_epoch` null,
  unless `include_never_seen` is no.
- Order: never seen first, then longest silent, then name.
- Reply: `{ minutes, cutoff_epoch, devices: [{ uid, name, type, kind, hardware_id, location,
  last_seen_epoch, silent_secs }] }`; `silent_secs` is null for never seen.
- Register the route before `/devices/:uid`, or "silent" is read as a uid.
- Named for the device page's Silent status. Devices only; silent sensors were not asked for.

Pure helpers beside `missingScope()`:

```js
// A minutes query parameter: a whole number from 1 to ten years of minutes; anything else is null (a 400).
function minutesOf(v)
{
    if (v === undefined || v === null || String(v).trim() === "") { return null; }
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 5256000 ? n : null;
}

// A yes or no query parameter: 1, true or yes, and 0, false or no, in any case. Absent or anything else is def.
function flagOf(v, def)
{
    const s = String(v === undefined || v === null ? "" : v).trim().toLowerCase();
    if (["1", "true", "yes"].includes(s)) { return true; }
    if (["0", "false", "no"].includes(s)) { return false; }
    return def;
}
```

The query on voltastc (knex, PostgreSQL). `NULLS FIRST` differs on SQL Server: there, order by a
`CASE WHEN last_seen_epoch IS NULL THEN 0 ELSE 1 END` first, then `last_seen_epoch`.

```js
const q = knex(T("devices") + " as d").join(T("device_types") + " as t", "t.id", "d.device_type_id").whereIn("d.location_id", Array.from(locs.keys()))
    .whereNull("d.delete_epoch").where("d.is_archived", false).where("d.is_offline", false)
    .where(function () { this.where("d.last_seen_epoch", "<=", cutoff); if (includeNever) { this.orWhereNull("d.last_seen_epoch"); } })
    .select("d.*", "t.slug as type").orderBy("d.last_seen_epoch", "asc", "first").orderBy("d.name", "asc");
```

## Part 3: API tabs

Pages show ready to run curl commands for what they show, with the page's real uids, the site's
base URL and the key variable from the docs (`$VOLTASTC_KEY` there; the target's own from
`envVarOf()`). The page never shows a key.

**One source.** `pageCalls(s, page)` lives in `services/apiDocs.js` beside `endpoints()`: each call
takes its method, path, permission and docs anchor from `endpoints()`, so the docs and the tabs
cannot drift. It returns `{ intro, calls: [{ docs, method, path, perm, about, example }] }`. `page`
is one of:

- `{ kind: "device", device: { uid, apiWrite, channels }, sensors: [{ uid, name }] }`
- `{ kind: "sensor", sensor: { uid, channel }, device: { uid, apiWrite }, rules: [{ uid, label }] }`
- `{ kind: "location-devices", location: { uid } }`
- `{ kind: "location-alarms", location: { uid }, account: { uid } or null }`
- `{ kind: "alarm", alarm: { uid, active } }`

**Where and what:**

| Page | URL | Calls |
|---|---|---|
| Device (gateways and nodes alike), tab before Settings | `/devices/<uid>/api` | the device; its sensors; readings, one command per sensor with a `# name` comment; its active alarms, history and rules; `POST /devices/<uid>/readings` only when the type has `apiWrite`, listing its channels |
| Sensor, tab before Settings | `/sensors/<uid>/api` | the sensor; its readings, active alarms, history and rules; one change log command per live rule (label: direction or "no data", then severity); the POST only with `apiWrite` |
| Location Devices, menu child after Unclaimed | `/locations/<uid>/devices/api` | `GET /devices?location=`; silent devices for 1440 minutes |
| Location Alarms, menu child after Notifications | `/locations/<uid>/alarms/api` | active alarms here and for the whole account; history; rules; a rule's change log with a `<rule uid>` placeholder; silent devices for 1440 minutes |
| Single alarm, tab (part 4) | `/alarms/<uid>/api` | the alarm's detail; ack and clear while it is active |

- Location menu children double as that section's tabs, so adding the child in `nav/menu.js` is all
  the tab needs.
- Shown to anyone who can view the page, like the docs tabs. The permission each call needs is
  printed beside it.
- One partial, `views/partials/api-usage.ejs`: an intro line with a link to the account's API Docs
  (`req.acctBase + "/api/docs"`), then per call the method and path, "needs <perm>", a Copy button
  (the site's existing clipboard helper; voltastc's is `window.iotExport.copy()` in
  `iot-table-tools.js`), a Docs button to `#<anchor>`, the about line and the command in a `pre`.
  Each page view is one line that includes the partial.
- No sample replies: made up values could be read as the device's own. The Docs link has them.
- Tests: every example contains the base URL and the key variable, every call has method, path,
  perm and about, the POST appears only with `apiWrite`, ack and clear only while active, the
  account call only with an account.

## Part 4: the alarm page has tabs

`/alarms/<uid>` was one page; it is now three tabs (`alarmTabs(a, current)`), sharing one
breadcrumb (`alarmTrail(a)`) and title:

- **Overview** `/alarms/<uid>`: the four stat cards, the Ack and Clear actions while active, and
  the timeline, full width.
- **Notifications** `/alarms/<uid>/notifications`: the Escalation panel (per alert group) and every
  send decision for the alarm, **newest first** (`orderBy epoch desc, id desc`), in a sortable table
  (voltastc: `table.is-sortable` with `public/js/iot-sort.js`). Two columns were added: **When**
  (`data-sort` is the epoch, header `sort-custom`) and **Event** (the alarm event that caused the
  send, from the alarm's events, for example "raised (alarm)"). The other columns sort as text. A
  row still opens the notification detail modal; include that modal on this tab, not on Overview.
- **API** `/alarms/<uid>/api`: part 3.

Check the site's router: `GET /:uid/notifications` and `GET /:uid/api` must not collide with any
existing alarm routes (voltastc has `GET /notifications/:id.json` and `POST /:uid/:action`, which
do not).

## Status codes on IIS sites (always 200)

voltastc sends real HTTP status codes. The IIS sites send every reply as HTTP 200 with the real code
in the `x-app-status` header and the body (`middleware/httpStatus.js`), because the customer's IIS
replaces error bodies. That thread likely knows this already.

- Write routes the normal way, `res.status(400).json(...)`; the middleware rewrites it. Confirm it
  covers the API router.
- A missing scope on IIS reaches the caller as HTTP 200 with `x-app-status: 400` and the error in
  the body. The API docs there already explain this (`alwaysOk` true).
- The tabs need no change for this; they only show commands.

## Docs and decisions

- Update `services/apiDocs.js` for every endpoint touched: the scope parameters and the sentence
  that one is required, the 400 in each note, `rule` on the change log with "Default: the rule's
  first change" for `from`, and a new `silent-devices` entry after `devices`. Run the docs tests:
  voltastc's forbid the words "this account" in the downloaded file and em dashes anywhere.
- Decisions log entries on voltastc, for reference: "API queries are scoped", "API silent
  devices", "API tabs", "The alarm page has tabs". Update the existing alarm rules entry to say
  both endpoints are scoped.
- Structure notes: the `apiHelpers` and `apiDocs` lines, and the partial.

## Suggested order

1. Audit; agree what may break.
2. `missingScope()`, `minutesOf()`, `flagOf()` with tests.
3. Scope on history, active (with `account`), rules, and `rule` on the change log with its default.
4. `GET /devices/silent`.
5. API docs for all of the above; decisions entries.
6. `pageCalls()` with tests, then the partial.
7. Device and sensor API tabs, then the two location menu children and their routes.
8. Alarm page tabs: split the route and view, the Notifications tab and its sortable table, the
   API tab.

After deploy: `/alarms/active` with no parameters answers 400 (HTTP 200 with `x-app-status: 400` on
IIS); `/alarms/active?location=<uid>` answers that location's alarms; `/devices/silent?location=
<uid>&minutes=1440` lists the quiet devices; open each API tab and run one copied command; on an
alarm, the Notifications tab shows the newest send first and sorts on a header click.
