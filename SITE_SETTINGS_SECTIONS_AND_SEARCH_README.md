# Site settings sections and search: port guide

Built and settled on voltastc (Oct 2026). This document describes three changes to the
Administration > Site settings page so they can be added to another site built from the same
platform (devmon, DTM, or any site that follows the iot-platform skill). It is written to be handed
to Claude (or a developer) working in the target repo, as the spec for the work.

Nothing here touches the database schema. The settings table, the settings cache and the save route
are unchanged; only the page and one display list in the route change.

## How to use this document

1. Read the target site's own decisions log, structure notes, `routes/admin.js` (settings part),
   `views/admin/settings.ejs`, its settings seed and its theme CSS first. Where the site already
   settled something that conflicts with this guide, stop and ask; do not overwrite it.
2. List the target's own site settings by group (tab) before writing anything. The section lists in
   step 2 name voltastc's keys; the target's will differ. Propose the target's sections to Jeff and
   agree them first.
3. Build in the steps below, one file or one concern at a time, with review between steps.
4. Record the decision in the site's decisions log (wording at the end).

## What it is

Before: the settings page had tabs (General, Email, MQTT, Logging and purge, API), but each tab was
one table sorted alphabetically by key, so General mixed passwords, MFA, alarm titles and retention
together. Each setting was one row with three columns (Setting, Value, Description); the long
descriptions took most of the width and squeezed the value fields.

After:

1. **Sections.** A tab can be split into titled panels, with the keys in a chosen order. Display only:
   a list in the route, no schema change, the stored group is untouched. A key of the tab that no
   section lists shows in an "Other" panel last, so a new setting can never disappear. A tab with no
   sections keeps its single table, looking as before.
2. **Search.** A box above the panels searches every setting on every tab, the way phone settings
   search works. Every word typed must appear in the key or the description (an underscore counts as
   a space); settings whose key holds every word are listed first. Each result shows the key, its tab
   and the start of its description. Arrow keys and Enter work, Esc clears. Picking a result on the
   same tab scrolls to the row and highlights it for 2.5 s; on another tab it loads that tab and
   highlights the row on arrival (`#setting-<KEY>` in the URL).
3. **Two row layout.** Each setting is two table rows: the key (and restart badge) with the value
   field, then the description under both, spanning the full width. No border between a setting's
   two rows. The table header is Setting and Value only. The value fields get about twice the width.

Voltastc's sections, for reference:

- General: Site (SITE_NAME); Sign in and sessions (SESSION_HOURS, LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MINUTES, MFA_ENABLED, MFA_CODE_MINUTES); Passwords and invitations (PW_MIN_LENGTH,
  PW_REQUIRE_UPPER, PW_REQUIRE_LOWER, PW_REQUIRE_DIGIT, PW_REQUIRE_SYMBOL, RESET_LINK_MINUTES,
  INVITE_DAYS, USERNAME_CHANGE_DAYS); Alarms and devices (ALARM_TITLE_FORMAT, RENOTIFY_MINUTES,
  ONLINE_THRESHOLD_SECS, COVERAGE_WINDOW_HOURS).
- Logging and purge: Data retention (RETENTION_DAYS_DEFAULT, REPORT_FILE_DAYS, moved here from
  General); Logs and purge (EVENT_LOG_DAYS, DEVICE_FRAMES_HOURS, RAW_PUBLISH_LOG_DAYS,
  PURGE_BATCH_ROWS).
- Email, MQTT, API: no sections (short tabs, already organized).

## What the target site must have (check, do not assume)

The code below fits the devmon lineage. Check each item; where the target differs, adapt and say so.

- `config/settings.js` `all()` returns cached rows with `key`, `kind`, `description`, `group`,
  `min`, `max`, `needsRestart`, `fromEnv`; the route copies them and adds `shown`.
- `routes/admin.js` has `GROUPS` (pairs of group and tab label, e.g. `["general", "General"]`),
  `settingsTabs()`, and `settingsPage()`, which builds `all`, `mailDrivers` (each with `name`,
  `label`, `keys`, `configured`), `driverKeys`, `shownAbove` and `rows`, and renders
  `admin/settings`. Tab paths are `/admin/settings` for general and `/admin/settings/<group>` for
  the rest.
- `views/admin/settings.ejs` draws every setting through a `row(s)` helper (which calls `field(s)`)
  and ends with one table of `rows` under a `<% if (rows.length) { %>` block.
- Bootstrap 5.3.x (the highlight relies on `--bs-table-bg-state`, added in 5.3) and the iot theme
  variables (`--iot-panel-alt`, `--iot-border`, `--iot-border-light`, `--iot-text`,
  `--iot-text-muted`, `--iot-nav-active-bg`, `--iot-radius`).
- Mail drivers that declare their own settings, with only the chosen driver's card shown. If the site
  has an SMS group with no tab (SMS hidden), the search leaves it out automatically because it only
  indexes groups in `GROUPS`.

## Step 1: seed (only if a key changes tab)

Skip this step if no setting moves to another tab. On voltastc two keys moved from general to
logging, by changing `group:` on their lines in `seeds/0001_site_settings.js`:

```js
    { key: "RETENTION_DAYS_DEFAULT", value: "90", kind: "int", group: "logging", description: "Reading retention when a sensor and account both inherit.", min: 1, max: 3650 },
```
```js
    { key: "REPORT_FILE_DAYS", value: "30", kind: "int", group: "logging", description: "Days generated report files are kept.", min: 1, max: 365 },
```

Before moving a key, check:

- **The seed rewrites the group of existing rows.** Voltastc's seed updates `setting_group` on every
  existing row ("group, description and bounds are owned by code; the value is the admin's"). If the
  target's seed only inserts missing keys, the move needs a migration
  (`UPDATE settings SET setting_group = 'logging' WHERE setting_key IN (...)`) instead.
- **Nothing reads the key by group.** Grep for `setting_group` and `.group`. On voltastc only
  `mqtt/watch.js` reads a group (`mqtt`, for its 15 s reconnect poll), so never move a key into or
  out of the mqtt group without checking that.
- **Deploy runs the seed.** On voltastc that is `deploy/install.sh`; a bare `pm2 reload` does not
  seed, and the key stays on its old tab.

## Step 2: route (`routes/admin.js`)

**2a.** Add after `settingsTabs()`. Replace the section lists with the target's agreed sections;
keys not present on the site are skipped, so a stale name does no harm, but keep the lists honest.

```js
// Display only: the panels on a settings tab and the order of keys in each. A tab key not listed
// here shows in an "Other" panel last, so a new setting never disappears. Unlisted tabs keep one table.
const SECTIONS =
{
    general:
    [
        ["Site", ["SITE_NAME"]],
        ["Sign in and sessions", ["SESSION_HOURS", "LOGIN_MAX_FAILURES", "LOGIN_WINDOW_MINUTES", "MFA_ENABLED", "MFA_CODE_MINUTES"]],
        ["Passwords and invitations", ["PW_MIN_LENGTH", "PW_REQUIRE_UPPER", "PW_REQUIRE_LOWER", "PW_REQUIRE_DIGIT", "PW_REQUIRE_SYMBOL", "RESET_LINK_MINUTES", "INVITE_DAYS", "USERNAME_CHANGE_DAYS"]],
        ["Alarms and devices", ["ALARM_TITLE_FORMAT", "RENOTIFY_MINUTES", "ONLINE_THRESHOLD_SECS", "COVERAGE_WINDOW_HOURS"]]
    ],
    logging:
    [
        ["Data retention", ["RETENTION_DAYS_DEFAULT", "REPORT_FILE_DAYS"]],
        ["Logs and purge", ["EVENT_LOG_DAYS", "DEVICE_FRAMES_HOURS", "RAW_PUBLISH_LOG_DAYS", "PURGE_BATCH_ROWS"]]
    ]
};

function settingsSections(group, rows)
{
    const left = new Map(rows.map((s) => [s.key, s]));
    const out = [];
    for (const [title, keys] of SECTIONS[group] || [])
    {
        const list = keys.filter((k) => left.has(k)).map((k) => left.get(k));
        keys.forEach((k) => left.delete(k));
        if (list.length) { out.push({ title: title, rows: list }); }
    }
    if (left.size) { out.push({ title: out.length ? "Other" : null, rows: Array.from(left.values()) }); }
    return out;
}

// Site settings search: every setting shown on some tab, with its tab. Leaves out the SMS group
// (no tab, SMS is hidden) and the settings of mail drivers other than the chosen one (not shown).
function settingsIndex(all, mailDrivers, mailChosen)
{
    const tabs = new Map(GROUPS);
    const hidden = new Set(mailDrivers.filter((d) => d.name !== mailChosen).flatMap((d) => d.keys));
    return all
        .filter((s) => tabs.has(s.group) && !hidden.has(s.key))
        .map((s) => ({ key: s.key, description: s.description || "", tab: tabs.get(s.group), path: "/admin/settings" + (s.group === "general" ? "" : "/" + s.group) }));
}
```

**2b.** In `settingsPage()`, in the `res.render("admin/settings", { ... })` object, add these two
lines under the existing `title: "Site settings", group: group, rows: ...` line. `rows` stays: the
sections get the same filtered rows the single table had.

```js
            sections: settingsSections(group, rows.filter((s) => !driverKeys.has(s.key) && !shownAbove.has(s.key))),
            searchIndex: settingsIndex(all, mailDrivers, mail.chosen().name),
```

Notes:

- `mail.chosen().name` is voltastc's name for the chosen mail driver (the view gets it as
  `mailChosen`). Use whatever the target uses for the same thing. If the site has no mail drivers,
  pass an empty list.
- The index carries key, description and tab only, never values, so no secret reaches the page.
- If the target's tab paths are not `/admin/settings[/<group>]`, change `path` to match
  `settingsTabs()`.

## Step 3: CSS (`public/css/iot-theme.css`)

Add at the end:

```css
/* Site settings search (views/admin/settings.ejs) */
.iot-setting-search { position: relative; max-width: 34rem; }
.iot-setting-results { position: absolute; z-index: 1050; left: 0; right: 0; top: 100%; margin-top: .25rem; max-height: 24rem; overflow-y: auto; background: var(--iot-panel-alt); border: 1px solid var(--iot-border-light); border-radius: var(--iot-radius); }
.iot-setting-results a { display: block; padding: .45rem .75rem; color: var(--iot-text); text-decoration: none; border-bottom: 1px solid var(--iot-border); }
.iot-setting-results a:last-child { border-bottom: 0; }
.iot-setting-results a:hover, .iot-setting-results a.active { background: var(--iot-nav-active-bg); }
.iot-setting-results small { display: block; color: var(--iot-text-muted); }
.iot-setting-results .iot-setting-none { padding: .45rem .75rem; color: var(--iot-text-muted); }
tr.iot-setting-hit { --bs-table-bg-state: var(--iot-nav-active-bg); }
.iot-table tr.iot-setting-main > td { border-bottom-width: 0; padding-bottom: .25rem; }
.iot-table tr.iot-setting-desc > td { padding-top: 0; }
```

Why it is written this way:

- **No Bootstrap dropdown or list group.** The site does not set Bootstrap's dark theme, so those
  components come up with a white background. The results list uses the theme variables instead.
- **The highlight sets `--bs-table-bg-state`, not `background`.** Bootstrap 5.3 paints table cells
  with `box-shadow: inset 0 0 0 9999px var(--bs-table-bg-state, ...)`, which covers a plain
  background. Setting the variable on the row is how `.table-active` itself works.
- **The two row rules out-rank Bootstrap's `.table>:not(caption)>*>*` and the theme's
  `.iot-table td` padding.** A setting with no description keeps a single row with its normal border
  (the `iot-setting-main` class is only added when a description row follows).

## Step 4: view (`views/admin/settings.ejs`)

**4a. Two row layout.** In `function row(s)`, replace the whole one row, three cell `<tr> ... </tr>`
(the third cell holds the description and the `(min to max)` range) with:

```ejs
  <% var help = (s.description || "") + (s.kind === "int" && s.min !== null ? " (" + s.min + " to " + s.max + ")" : ""); %>
  <tr id="setting-<%= s.key %>"<%- help ? ' class="iot-setting-main"' : "" %>>
    <td><code><%= s.key %></code><% if (s.needsRestart) { %> <span class="badge text-bg-warning">restart</span><% } %></td>
    <td><% field(s); %></td>
  </tr>
  <% if (help) { %><tr class="iot-setting-desc"><td colspan="2" class="small text-secondary"><%= help %></td></tr><% } %>
```

Every table on the page that has a header row (on voltastc two: the Mail provider From table and the
sections table) changes its three `<th>` cells to:

```html
<th style="width: 32%">Setting</th><th>Value</th>
```

Tables without a header (the driver cards) need no change; they draw through `row()` too.

Two rows per setting, rather than one `<tbody>` per setting: `row()` is called inside each table's
existing `<tbody>`, and a `<tbody>` cannot nest, so wrapping would mean rewriting every table on the
page.

**4b. Search box.** Directly above the first panel (on voltastc, just above
`<% if (group === "email") { %>`, the first line after the `field` and `row` helpers):

```ejs
<div class="iot-setting-search mb-3">
  <input type="search" class="form-control form-control-sm" id="settingSearch" placeholder="Search all settings by name or description" autocomplete="off" aria-label="Search settings">
  <div class="iot-setting-results d-none" id="settingResults"></div>
</div>
```

**4c. Sections.** Replace the final `<% if (rows.length) { %> ... <% } %>` table block with the
block below. The Email tab's "Support requests" header is voltastc's: keep whatever header the
target's Email tab has there, or drop that branch. The last panel has no bottom margin, so the gap
above the `.env` note is unchanged. If no section has rows, nothing is drawn, as before.

```ejs
<% sections.forEach(function (sec, i) { %>
<div class="iot-panel<%= i < sections.length - 1 ? " mb-3" : "" %>">
  <% if (group === "email") { %><div class="iot-panel__header"><strong>Support requests</strong> <span class="text-secondary small ms-2">requests are always saved in the app; these decide who is emailed and from which address</span></div><% } else if (sec.title) { %><div class="iot-panel__header"><strong><%= sec.title %></strong></div><% } %>
  <div class="table-responsive"><table class="table iot-table align-middle mb-0" data-tools="none"><thead><tr><th style="width: 32%">Setting</th><th>Value</th></tr></thead><tbody>
  <% sec.rows.forEach(function (s) { row(s); }); %>
  </tbody></table></div>
</div>
<% }); %>
```

**4d. Script.** At the very end of the file. The index goes in with `<` escaped, the same as the
event log page; results are built with `textContent`, never HTML. Inline page scripts run on
`DOMContentLoaded` because vendor libraries load at the end of the body.

```html
<script>
var SETTINGS_INDEX = <%- JSON.stringify(searchIndex).replace(/</g, "\\u003c") %>;
document.addEventListener("DOMContentLoaded", function ()
{
    var box = document.getElementById("settingSearch");
    var list = document.getElementById("settingResults");
    var shown = [];
    var pick = -1;

    // Scroll to a setting's rows (key and value, then its description) and highlight them for a moment.
    function highlight(key)
    {
        var tr = document.getElementById("setting-" + key);
        if (!tr) { return; }
        var rows = [tr];
        if (tr.nextElementSibling && tr.nextElementSibling.classList.contains("iot-setting-desc")) { rows.push(tr.nextElementSibling); }
        tr.scrollIntoView({ block: "center" });
        rows.forEach(function (r) { r.classList.add("iot-setting-hit"); });
        setTimeout(function () { rows.forEach(function (r) { r.classList.remove("iot-setting-hit"); }); }, 2500);
    }

    // Every word typed must appear in the key or the description (an underscore counts as a space).
    // Settings whose key holds every word come first.
    function search(q)
    {
        var words = q.toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
        if (!words.length) { return []; }
        var has = function (text) { return words.every(function (w) { return text.indexOf(w) !== -1; }); };
        var inKey = function (s) { return has(s.key.toLowerCase().replace(/_/g, " ")); };
        var hits = SETTINGS_INDEX.filter(function (s) { return has((s.key.replace(/_/g, " ") + " " + s.description).toLowerCase()); });
        return hits.filter(inKey).concat(hits.filter(function (s) { return !inKey(s); }));
    }

    function hide()
    {
        list.classList.add("d-none");
    }

    // Same tab: highlight in place. Another tab: load it; the hash check below highlights on arrival.
    function go(s)
    {
        if (s.path === location.pathname)
        {
            history.replaceState(null, "", "#setting-" + s.key);
            hide();
            highlight(s.key);
        }
        else
        {
            location.href = s.path + "#setting-" + s.key;
        }
    }

    function mark()
    {
        Array.prototype.forEach.call(list.querySelectorAll("a"), function (a, i)
        {
            a.classList.toggle("active", i === pick);
            if (i === pick) { a.scrollIntoView({ block: "nearest" }); }
        });
    }

    function render()
    {
        shown = search(box.value);
        pick = shown.length ? 0 : -1;
        list.textContent = "";
        if (!box.value.trim()) { hide(); return; }
        if (!shown.length)
        {
            var none = document.createElement("div");
            none.className = "iot-setting-none";
            none.textContent = "No settings match.";
            list.appendChild(none);
        }
        shown.forEach(function (s)
        {
            var a = document.createElement("a");
            a.href = s.path + "#setting-" + s.key;
            var code = document.createElement("code");
            code.textContent = s.key;
            var tab = document.createElement("span");
            tab.className = "text-secondary small ms-2";
            tab.textContent = s.tab;
            var desc = document.createElement("small");
            desc.textContent = s.description.length > 140 ? s.description.slice(0, 140) + "..." : s.description;
            a.appendChild(code);
            a.appendChild(tab);
            a.appendChild(desc);
            a.addEventListener("click", function (e) { e.preventDefault(); go(s); });
            list.appendChild(a);
        });
        list.classList.remove("d-none");
        mark();
    }

    box.addEventListener("input", render);
    box.addEventListener("focus", function () { if (box.value.trim()) { render(); } });
    box.addEventListener("keydown", function (e)
    {
        if (e.key === "ArrowDown" && shown.length) { e.preventDefault(); pick = (pick + 1) % shown.length; mark(); }
        else if (e.key === "ArrowUp" && shown.length) { e.preventDefault(); pick = (pick - 1 + shown.length) % shown.length; mark(); }
        else if (e.key === "Enter" && pick >= 0) { e.preventDefault(); go(shown[pick]); }
        else if (e.key === "Escape") { box.value = ""; hide(); }
    });
    document.addEventListener("click", function (e) { if (!e.target.closest(".iot-setting-search")) { hide(); } });

    // Arrived from a search result on another tab.
    if (location.hash.indexOf("#setting-") === 0) { highlight(decodeURIComponent(location.hash.slice(9))); }
});
</script>
```

Known gap: a setting drawn as something other than a `row()` (on voltastc, `MAIL_DRIVER`, the
dropdown in the Mail provider panel) has no row id. Its search result opens the right tab with
nothing highlighted. Acceptable, since the driver dropdown is at the top of the Email tab.

## Checking it

How it was checked on voltastc (the app does not run on Jeff's Mac, so nothing here needs a
database):

1. `node --check routes/admin.js`.
2. Render `views/admin/settings.ejs` with `ejs` for every tab, feeding it the seed's settings and the
   route's own `settingsSections()` and `settingsIndex()` (sliced out of the route file, so the test
   uses the real code). Confirm each tab's panels and key order, that an unlisted key lands in
   "Other", that tabs with no sections draw one untitled table, that the index leaves out the other
   mail drivers' keys and the SMS group, and that a setting with no description is one row.
3. Extract the rendered `<script>` and `node --check` it.
4. Load the rendered page with the real Bootstrap and theme CSS in headless Chromium: screenshot at
   1000 px and 1500 px wide, type into the search box, and open the page with
   `#setting-<KEY>` to confirm both rows get `iot-setting-hit` and lose it after 2.5 s, with no page
   errors. (Picking a result in a test page loaded from a file navigates away, because the result's
   `/admin/settings` path never matches a file path; test the arrival path instead.)
5. After deploying, on the real site: search for something on another tab, pick it, and confirm the
   jump and the highlight. Check boolean switches show their real state (test data passed as text
   shows every switch on).

## Suggested build order

1. Seed group moves, if any (deploy with the seed).
2. Route: `SECTIONS`, `settingsSections()`, the `sections` render line. No visible change yet.
3. View 4c: sections render. Review the tabs.
4. Route: `settingsIndex()` and the `searchIndex` render line; CSS; view 4b and 4d: search.
5. View 4a, the header cells and the two layout CSS rules: two row layout.
6. Decisions log entry.

Steps 2 and 3 can go alone if only sections are wanted; search and the two row layout are
independent of each other.

## Decisions to record on the target site

Voltastc's `DECISIONS.md` entry (Navigation and UI), to adapt:

- **Site settings sections and search** (Oct 2026, Jeff). Sections are display only: `SECTIONS` in
  `routes/admin.js` lists the panels of a tab and the order of keys in each. A key of the tab not
  listed shows in an "Other" panel last, so a new setting never disappears; unlisted tabs keep one
  table. (Name any keys moved between groups.) The search box above the panels matches every word
  typed against the key and description of every setting shown on some tab (`settingsIndex()`: not
  the SMS group, not the settings of mail drivers other than the chosen one), key matches first, and
  jumps to the row (`#setting-<KEY>`) with a short highlight. Each setting is two rows: key and
  value, then its description under both.
