# Alarm charts: port guide

Built and settled on voltastc (Oct 2026). This document describes the alarm charts so they can be
added to another site built from the same platform (devmon, DTM, or any site that follows the
iot-platform skill): the sensor chart in alarm emails, alarm markers on the sensor chart (live), the
alarm page chart, and alarm values and times in the location's units and timezone. It is written to
be handed to Claude (or a developer) working in the target repo, as the spec for the work. It is an
addendum to the chart tools (the chart-tools skill): a site needs those first. voltastc's
`DECISIONS.md` entries named below are the short form; this is the long form with the reasons and
the order of work.

## How to use this document

1. Read the target site's own decisions log, structure notes, the sensor page view and route, the
   alarm engine, notify and title services, the mail drivers, the live feed script and the alarm
   page. Where the site already settled something that conflicts with this guide, stop and ask; do
   not overwrite it.
2. Check what the target has (next section) and say which steps apply before writing anything.
3. Agree the choices under "Agree first" with Jeff.
4. Build in the steps below, one concern at a time, with review between steps.
5. Record each decision in the target's decisions log and structure notes as the step lands.

A prompt to start the work on another site:

> Read ALARM_CHARTS_README.md (attached or in the repo) and this site's decisions log and
> structure notes. Add the alarm charts following the guide. First tell me what this site already
> has from the "What the target site must have" list and any conflict with this site's decisions,
> then ask me the "Agree first" questions. Then build it in the guide's steps, one reviewed step at
> a time.

## What it is

- **Chart in alarm emails.** A threshold rule's first alarm email and its clear email carry the
  sensor's chart as an inline image: the same threshold bands, threshold lines, y axis rule and
  alarm markers as the sensor page, dark like the site, with the alarm title and the window above
  it. Escalations, lowerings, re-notifications, no_data rules and SMS get none.
- **Per rule settings.** Include chart in alarm (default on) and Chart window: Auto (twice the
  exceed time, at least 30 days), or 1, 7, 14, 30, 60 or 90 days, 6 months, 1 year. Every window is
  at most a year. The raised image ends at the raise; the clear image ends at the clear and
  stretches back so the raise sits 5% in from the left, unless that passes a year.
- **Alarm markers** on the sensor chart: a dotted vertical line per event with a triangle at the top.
  Raise or escalate: right pointing, in the new severity's color. Lower: left pointing, in the
  color of the level it left. Clear: left pointing, in the severity it cleared from (the highest
  still active). Hovering a triangle shows "<time>, <what>" above the plot. New markers appear live.
- **Alarm page chart.** The alarm's Overview tab shows the sensor chart under the four cards, drawn
  live in the browser (not a stored image), with the window from the email rules: cleared, the
  clear email's window; active, from before the raise up to now, with live points and markers. The
  panel header links to the sensor page and to the rule that raised it on the sensor's Alarm rules
  tab (`#rule-<uid>`).
- **Location units and time.** Every alarm message and display words values in the location's
  units (`display.format`: sensor unit, else location, else account, else canonical). The alarm
  time reads `Alarm time: 2026-10-06 09:55 PM (Chicago CDT)` in the location's timezone, with
  `Cleared: <time>` on clear emails.
- **HTML alarm emails** with a plain text part: each block a paragraph, everything escaped, links
  clickable, the chart after the alarm facts.

## What the target site must have (check, do not assume)

- **The chart tools** (chart-tools skill): `/data` returning raw chunks with `more` and `next_to`,
  `iot-chart-tools.js` (Download, Share, URL view, Custom, Load 30 more days), sensor chart with
  threshold bands. Without them, port those first.
- **An alarm engine with an events table** whose kinds are raised, escalated, de_escalated,
  cleared, suppressed (voltastc `alarm_events`), alarms with `rule_id`, `raised_epoch`,
  `cleared_epoch`, and rules with `exceed_secs`.
- **A notify service** that resolves recipients and calls the mail service per recipient. Note
  whether it sends text only.
- **Mail drivers that take attachments** (`{ filename, contentType, data }`). Read each driver's
  mapping; the SES one must send `ContentTransferEncoding: "BASE64"`.
- **A unit resolver** like `display.resolveUnit` and `display.format` (sensor, location, account
  settings). Find every place an alarm value is put into words.
- **The live feed**: does the readings publish carry alarm transitions with the sensor uid
  (voltastc `pipeline/publish.js` `msg.alarms`), and how does the page script append points
  (`window.devmonChart`).
- **Locations with an IANA timezone.**
- **Node 22 or older for `@resvg/resvg-js` 2.6.2** (its prebuilt binaries cover Node 12 to 22 on
  Linux x64 gnu and musl, macOS, Windows x64 and arm64).

## Agree first

1. Which emails get the image (voltastc: first raise and clear only) and whether SMS ever does
   (voltastc: no; Twilio MMS needs a public media URL, against "no public links").
2. The Auto window (voltastc: twice exceed, at least 30 days, at most a year) and the presets.
3. Dark or light image (voltastc: dark, like the site).
4. Alarm page chart live in the browser (voltastc) or the stored emailed image.
5. That every alarm value uses the location's units (voltastc: yes, everywhere).

## Step 1: alarm values and times

- Make the notify value formatter async and route it through the site's `display.format` with the
  location (`{ id: location_id, account_id }`). Update every caller: email body, SMS, alarm page
  Trigger card, the emailed action page, any rules list that passed no location.
- Replace the ISO "Since:" line with `Alarm time:` in the location's zone, plus `Cleared:` on
  clear emails: `Intl.DateTimeFormat("en-US", { timeZone, ..., hour12: true, timeZoneName:
  "short" }).formatToParts()`, the zone's city from the IANA name, the abbreviation Intl gives for
  that moment (CDT or CST; an offset such as GMT+2 where en-US has none), UTC on a bad zone.

## Step 2: one chart drawing file for browser and server

Move the bands, threshold lines, y axis bounds and the whole ECharts option out of the sensor page
into `public/js/iot-sensor-chart.js`, unchanged, ending with
`if (typeof module === "object" && module.exports) { module.exports = api; } else { root.iotSensorChart = api; }`
so the page loads it with a script tag and the server with `require()`. Colors come in through
`themeColors(get)`: `getComputedStyle` in the browser, the theme CSS file's `:root` block on the
server. Without `zoom` the option is a still image (no slider, no tooltip, smaller bottom margin).
**Prove nothing moved:** run the old inline code (from a backup) and the new file on the same data
and compare the options as JSON plus the y bound functions and tooltip formatter (voltastc: 12
cases, rules none, one, a ladder both sides with an unknown severity, fit on and off, zoom kept and
reset). Add unit tests.

## Step 3: one chart loader for every sensor chart page

Move the page side (chunk loading, live points, Download, Share, zoom in the URL, range buttons with
Custom, Fit to data, Load 30 more days) into `public/js/iot-sensor-view.js`,
`iotSensorView.mount(o)`, with the page specific parts as options (`rangeGroup`, `fitButton`,
`loadMore`, a starting `window`). The sensor page mounts it with everything; the alarm page with a
window only. Check in a browser that the sensor page makes the same requests as before.

## Step 4: alarm markers

- Repo: `markerEvents(sensorId, from, to)`: raised, escalated, de_escalated, cleared and suppressed
  events of the sensor's alarms that overlap the window, oldest first, including events before
  `from` (a lowering needs the level it left), none after `to`.
- `/data?alarms=1` adds `alarms: [{ uid, epoch, event_kind, severity }]`. Asked once per window
  (first request of a load, first request of Load 30 more days), not per chunk; merge older windows
  with a dedupe on uid, epoch, kind and severity.
- `alarmMarkers(events, from, to)` in the drawing file applies the rules under "What it is"; a
  suppressed alarm draws nothing until its suppression lifts (that writes a raised event).
- Draw them on a second series with no data, so they can be hovered while threshold lines stay
  silent. See the ECharts lessons for the item shape.

## Step 5: live markers

`live.js` passes each transition in the feed for the charted sensor to
`window.devmonChart.alarm({ uid, epoch, event_kind, severity })`, after the readings of the same
message (so the chart already reaches that epoch). The loader merges it and redraws keeping the
zoom. Only transitions that come from readings reach the feed on voltastc; a manual clear, an
offline clear, a no_data alarm or a lifted suppression shows after a reload.

## Step 6: rule settings

Migration: `chart_in_alarm` (boolean, default true) and `chart_window_secs` (integer, null is Auto)
on the rules table. Rule form: a switch and a dropdown shown for threshold rules only; a no_data rule
saves the defaults. Add both to the rule change log (fields, labels, wording: "Auto", "7 days",
"no chart"), its typed API values, the rules API listing and the API docs. A rule logged before the
migration has no `chart_in_alarm` in its snapshot: read missing as on.

## Step 7: dependencies and font

`echarts` (the same version as the vendored browser copy) and `@resvg/resvg-js` from npm, pinned
exact; keep the lockfile's other platforms' optional binaries (npm does). Inter Regular and SemiBold
TTF from the official release (rsms/inter, `extras/ttf/`) with its OFL license in `assets/fonts`.

## Step 8: the image

`services/alarms/chartImage.js`:

- `windowFor(rule, raisedEpoch, endEpoch, includeRaise)` and `pageWindowFor(rule, raised, cleared,
  now)` (the alarm page), pure and unit tested.
- `render(d, meta)`, pure: shift every time into the location's wall clock (see lessons), take the
  shared option without zoom, add `useUTC`, the panel background, Inter, the two title lines and a
  taller top margin, set the marker series silent, `echarts.init(null, null, { renderer: "svg",
  ssr: true, width: 1000, height: 440 })`, `renderToSVGString()`, **`dispose()` in a finally**,
  then `new Resvg(svg, { fitTo: { mode: "zoom", value: 2 }, font: { loadSystemFonts: false,
  fontFiles, defaultFontFamily: "Inter" } }).render().asPng()`.
- `forAlarm(ctx, rule, eventKind, endEpoch, title)`: threshold rules with the switch on, raised or
  cleared only; readings (newest 100,000), enabled thresholds and marker events in display units;
  logs time and size; any failure logs and answers null so the email goes without it. Load the
  logger and database modules inside it so the pure parts test without an environment.
- An operator script that draws one alarm's image to a file (voltastc `scripts/alarm-chart.js
  <alarm uid> [raised|cleared] [out.png]`).

## Step 9: inline images in the mail drivers

An attachment may carry `cid`. SES: `ContentDisposition: "INLINE"`, `ContentId: cid` (no angle
brackets, per the SES attachments guide). SendGrid: `disposition: "inline"`, `content_id: cid`.
SMTP (nodemailer): `cid` and `contentDisposition: "inline"`; it builds `multipart/related`. Check
SMTP with nodemailer's stream transport and SendGrid with `@sendgrid/helpers` `Mail.create().toJSON()`.

## Step 10: HTML alarm emails with the chart

In notify: word the value once per run; draw the image once per run, lazily on the first email
that passes the gates, the window ending at the event's own epoch (a raise after a lifted
suppression is later than `raised_epoch`); build the HTML from the text body (escape, linkify the
two known links, image after the first block, `width="1000"` with `width: 100%; max-width:
1000px`); send `html` and `attachments: [{ ..., cid }]`.

## Step 11: the alarm page chart

Route: for threshold alarms, the rule, `pageWindowFor`, the resolved unit's precision and the rule
uid when the rule is live. View: a panel under the cards with the chart div, footer and note, header
links to the sensor page and `/sensors/<uid>/rules#rule-<uid>`; mount the loader with the window. On
the rules tab put `<div id="rule-<uid>" style="scroll-margin-top: 72px"></div>` before each rule.

## Step 12: documents

Decisions log entries (voltastc names): "Sensor chart drawing is one file for the browser and the
server" (with the loader), "Alarm markers on the sensor chart", "Chart image in alarm emails",
"Alarm emails are HTML", "Alarm values in the location's units", "Alarm page chart", "Inline
images". Structure notes for the new files and folders.

## SQL Server and Windows targets

- Migration: `BIT NOT NULL DEFAULT 1` for `chart_in_alarm`, `INT NULL` for `chart_window_secs`;
  the site's own migration syntax and booleans (1 and 0).
- resvg ships `win32-x64-msvc` and `win32-arm64-msvc` binaries, so IIS with iisnode works; keep the
  font files inside the app folder and give the app pool identity read access.
- Check the marker events query's `whereIn` and ordering against the site's knex dialect.

## Lessons learned (voltastc, Oct 2026)

- **Dispose the chart.** After `renderToSVGString()` an undisposed SSR chart keeps a timer running
  and the process never exits (seen in 6.1.0 even with `animation: false`). In the ingest process
  that is a leak.
- **System fonts.** Loading them through resvg in a container with many fonts hung; a server may
  have none. Ship Inter and set `loadSystemFonts: false`.
- **Marker lines, ECharts 6.1.0 source.** A markLine end with an infinite y goes to the bottom of
  the plot for the "from" end and the top for the "to" end whatever the sign
  (`MarkLineView.js updateSingleMarkerEndLayout`), and a one point item (`{ xAxis: t, ... }`) gives
  its options to the bottom end only (`markLineTransform` clones the item into "from", "to" is
  bare). So each marker is a two point item: `[{ coord: [t, Infinity], symbol: "none", name,
  lineStyle, label }, { coord: [t, Infinity], symbol: "triangle", symbolRotate: -90 (right) or 90
  (left), itemStyle }]`.
- **No marker tooltips beside an axis tooltip.** With `tooltip.trigger: "axis"` ECharts always shows
  the axis tip inside the grid (`TooltipView._tryShow` takes `dataByCoordSys` first), so a markLine
  tooltip never shows. Use a label shown on hover (`label.show: false`, `emphasis.label.show:
  true`, position `end`, right aligned past the middle so it stays on the canvas).
- **Server side time axis.** ECharts labels a time axis in the process's zone or UTC (`useUTC`),
  never another zone. Shift every time by the location's offset at that moment (cache per hour;
  `Intl.DateTimeFormat` with `hourCycle: "h23"`, `formatToParts`) and draw with `useUTC: true`.
- **SendGrid `content_id`.** `@sendgrid/helpers` converts option keys to snake case but skips arrays
  (`helpers/convert-keys.js`), so a camel case `contentId` in the attachments list goes out
  unconverted. Write `content_id`.
- **Units drift.** The notify formatter used the sensor's unit or canonical while the pages used the
  location's setting, so a location set to F got a C value beside an F chart. Use the one formatter.
- **Unit tests on Jeff's Mac** fail for anything that loads the logger or database (environment and
  RDS CA path). Keep pure parts free of those requires.
- **Headless checks.** Render the image in a container with stub logger and metrics modules and look
  at the PNG; test the page scripts with Playwright, a fake `/data` via `page.route`, the real
  `live.js` with a fake `io` that records handlers, and Bootstrap loaded.

## Checking it

- Unit tests: the drawing file (bands, bounds, threshold labels, markers: escalate then clear,
  lowering color, window filter, suppressed), the windows (Auto, preset, year cap, clear stretch,
  page window), the timezone shift across daylight saving, theme colors from the CSS file.
- On the server: `node scripts/alarm-chart.js <alarm uid> raised /tmp/a.png` and `cleared`; raise
  and clear a test alarm and read both emails in Apple Mail, Outlook and Gmail; open the alarm page
  for an active and a cleared alarm; watch a sensor page while a test alarm raises and escalates.
- Log lines: `alarm chart drawn` (readings, bytes, ms) and `alarm chart failed, sending without it`.

## Known gaps (left on purpose)

- Saved charts and dashboards show no markers (a chart may hold several sensors; Jeff: later).
- Live markers only for transitions that come from readings.
- Drawing takes about half a second in the notifying process for each raised and cleared email run.
