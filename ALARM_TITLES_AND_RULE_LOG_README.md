# Alarm titles and the alarm rule change log: port guide

Built and settled on devmon (Oct 2026). This document describes both features so they can be added
to another Express site with an alarms feature. It is written to be handed to Claude (or a
developer) working in the target repo, as the spec for the work.

The target sites are likely PostgreSQL. Nothing here depends on a database engine: the SQL shown is
plain and portable, and the code uses whatever query layer the site already has (knex, pg, an ORM).

## How to use this document

1. Read the target site's own decisions log, structure notes and alarm code first. Where the site
   already settled something that conflicts with this guide, stop and ask; do not overwrite it.
2. Map the terms below to the site's own tables. If the site has fewer levels (no accounts, no
   devices), drop those levels from the chain; do not invent them.
3. Agree a plan, then build in small reviewable steps (suggested order at the end), one concern
   at a time, with review between steps.
4. Record each decision in the site's decisions log as it is made.

## Terms

| Term | Meaning on devmon | Map to the target site's |
|---|---|---|
| account | tenant (customer) | tenant, customer, company |
| location | site or building inside an account | site, facility, room |
| device | a unit with one or more sensors | device, node, logger |
| sensor | one measured channel on a device | sensor, channel, probe |
| alarm rule | a limit on one sensor: threshold (upper or lower) or no data (timeout) | alarm limit, alert rule |
| alarm | one occurrence: raised, maybe escalated, cleared | alarm, alert, incident |
| alarm event | each transition of an alarm (raised, escalated, cleared...) with the value at that moment | alarm history row |
| notification | one email or SMS decision, with its subject | notification log row |

Values are stored in a canonical unit (temperature in C, for example) and converted to the display
unit for people. If the target site stores display values directly, skip the conversion steps.

---

# Part A: Alarm title

## What it is

One line of text per alarm, used in three places, always identical:

1. **Email subject**, after the event word: `ALARM: Main 1 door open, please address immediately`
2. **First line of the SMS**, followed by the value (when there is one) and the alarm link, one per line.
3. **`name` in the API** alarm endpoints (list, history, detail), without the event word.

All three come from one resolver function. Never build the subject anywhere else.

## Event word

The subject is `<event word>: <title>`. The title never contains the event, so the same title reads
correctly on raise and on clear.

| Event | Event word |
|---|---|
| raised | severity in upper case, e.g. `ALARM`, `WARNING` |
| escalated | `ESCALATED to <severity>` |
| de-escalated | `lowered to <severity>` |
| cleared | `CLEARED` |
| repeat notification | `still <SEVERITY>` |

There is no fixed site prefix such as `[site name]`. Use the `{site_name}` token if wanted.

## Where the title comes from (most specific wins)

The first level with a non blank template wins:

1. the alarm rule
2. the sensor
3. the device
4. the location
5. the account
6. the site setting `ALARM_TITLE_FORMAT`
7. a default in code, the same text as the seeded site setting

Storage:

- **Levels that already have a scoped settings table** (devmon: account and location, key/value
  tables) store a row with key `ALARM_TITLE_FORMAT`. Do not add a column where a settings table
  is the site's pattern.
- **Levels without a settings table** (devmon: rule, sensor, device) get a nullable column
  `alarm_title`, 200 characters. NULL means inherit.
- **Site setting** `ALARM_TITLE_FORMAT`, seeded with
  `{sensor_name} on {device_name} at {location_name}`.

Which rule: the rule that set the alarm's **current** severity (devmon: `alarm.rule_id`, moved by
the escalation ladder). If only the "alarm" level rule has a custom title and the "warning" rule
does not, the title changes when the alarm escalates. That is intended.

**No data alarms use the same chain and the same tokens.** (An early plan had them always use the
site default; that was dropped.)

## Tokens

| Token | Threshold alarm | No data alarm |
|---|---|---|
| `{site_name}` | site name setting | same |
| `{account_name}` | account name | same |
| `{location_name}` | location name | same |
| `{device_name}` | device name | same |
| `{sensor_name}` | sensor name | same |
| `{severity}` | current severity as stored, e.g. `alarm` | same |
| `{direction}` | `above` or `below` | `no data` |
| `{alarm_limit}` | rule threshold in the display unit, e.g. `-10.0 C` | `no data` |
| `{exceed_value}` | the reading that raised the alarm, display unit | blank |
| `{return_value}` | the reading on the cleared event, display unit; blank until cleared and for manual clears | blank |
| `{exceed_duration}` | rule exceed delay in words, e.g. `5 minutes` | rule timeout in words, e.g. `30 minutes` |
| `{return_duration}` | rule return delay in words | blank |

Notes:

- A title that uses `{return_value}` reads differently once the alarm clears, and the API `name`
  changes with it. Expected.
- Values (`{alarm_limit}`, `{exceed_value}`, `{return_value}`) use the same display unit lookup
  the API uses (devmon: sensor unit, then location setting, then account setting, then the metric
  default), so the email and the API always agree.

## Rendering rules

- A token that is not in the list is **left as typed** (`{senser_name}` stays visible), so a typo
  shows up in the first subject instead of silently vanishing.
- A known token with no value renders blank.
- Line breaks and runs of white space become one space; the result is trimmed. The title is an
  email subject and must be one line.
- Durations in words, largest units first, singular or plural:
  `0` is `0 seconds`, `45` is `45 seconds`, `60` is `1 minute`, `1800` is `30 minutes`,
  `5400` is `1 hour 30 minutes`, `90061` is `1 day 1 hour 1 minute 1 second`. Unset is blank.

## Saving a title

Every form stores through one cleaner: collapse white space to single spaces, trim, cut to 200
characters, blank becomes NULL (inherit). For a settings table level, blank deletes the row.

## Resolver module

One module (devmon: `services/alarms/title.js`). Pure functions, unit tested, plus two async ones.

| Function | Does |
|---|---|
| `pick(levels)` | `levels` is `[{ source, template }]` most specific first; returns the first non blank, else the code default with source `default` |
| `render(template, vars)` | fills tokens per the rules above |
| `duration(secs)` | seconds in words |
| `tokens(ctx, rule, formatted)` | builds the token values; `formatted` carries the already formatted values (site name, limit, exceed value, return value) |
| `clean(text)` | the save cleaner |
| `forAlarm(ctx, rule)` | the title for one alarm: reads the chain, formats the values, renders |
| `inherited(level, known)` | what a level gets when its own field is blank: `{ source, template, sourceText }`, for form placeholders |
| `TOKENS` | the token names, for help text on the forms |

`ctx` is the alarm joined to its sensor, device, location and account: names, ids, the sensor's
metric and display settings, the sensor's and device's `alarm_title`, the alarm's `direction`,
`severity`, `trigger_value`, `cleared_at`. `rule` is the alarm's rule row or null. A soft deleted
rule still has its row, so its title still applies.

Reference for the pure parts (Allman braces, plain Node):

```js
const FALLBACK = "{sensor_name} on {device_name} at {location_name}";
const DIRECTION_WORDS = { upper: "above", lower: "below", no_data: "no data" };

function pick(levels)
{
    for (const l of levels)
    {
        const t = l.template === null || l.template === undefined ? "" : String(l.template).trim();
        if (t) { return { source: l.source, template: t }; }
    }
    return { source: "default", template: FALLBACK };
}

function render(template, vars)
{
    const out = String(template).replace(/\{([a-z_]+)\}/g, (whole, name) =>
    {
        if (!Object.prototype.hasOwnProperty.call(vars, name)) { return whole; }
        const v = vars[name];
        return v === null || v === undefined ? "" : String(v);
    });
    return out.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function duration(secs)
{
    if (secs === null || secs === undefined || secs === "") { return ""; }
    let s = Math.round(Number(secs));
    if (!Number.isFinite(s) || s < 0) { return ""; }
    if (s === 0) { return "0 seconds"; }
    const parts = [];
    for (const [name, size] of [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]])
    {
        const n = Math.floor(s / size);
        if (n > 0)
        {
            parts.push(n + " " + name + (n === 1 ? "" : "s"));
            s -= n * size;
        }
    }
    return parts.join(" ");
}

function clean(v)
{
    return String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim().slice(0, 200) || null;
}
```

`tokens()` maps the table above. For a no data alarm: `alarm_limit` is `no data`, the value
tokens are blank, `exceed_duration` comes from the timeout, `return_duration` is blank. With no
rule, both durations are blank. (Note: in JavaScript `return {` must stay on one line; a newline
after `return` returns undefined. That is the one place Allman style cannot apply.)

`forAlarm()` in outline:

1. Read the location's and account's `ALARM_TITLE_FORMAT` (through the site's settings cache if
   it has one).
2. `pick()` over rule, sensor, device, location, account, site setting.
3. Only if the chosen template contains `{return_value}` and the alarm is cleared, read the value
   from the latest cleared event. This keeps list endpoints from running a query per row.
4. Format the threshold, trigger value and return value with the site's display formatter.
5. `render(template, tokens(...))`.

## Sending notifications

- Resolve the title **once per notification run** (one alarm event), then build every recipient's
  subject from it.
- Wrap the resolve in try/catch. If it fails, log a warning and use plain names
  (`<sensor> on <device> at <location>`). A title problem must never stop an alarm going out.
- Store the full subject on each notification log row, sent or suppressed, so the alarm page and
  the API show exactly what went out.
- SMS text: `<subject>\n<value>\n<alarm link>`, value line left out when there is none.

## API

- Add `name` (the title without the event word) to every alarm object the API returns: active
  list, history, single alarm detail.
- List endpoints: read the rules for the page in one query (`WHERE id IN (...)`) and the account
  names in one query, then call `forAlarm()` per row. Location and account titles come from the
  settings cache, so no per row queries.
- Document `name` in the API docs: "the alarm title, the same text as the email subject after the
  event word".

## Forms

- A field "Alarm title" on each level's settings page and in the alarm rule form, 200 characters.
- Placeholder: the template the level inherits right now (`inherited()`).
- Help text: "Blank uses the <source> title shown", where source is sensor, device, location,
  account, site default or built in default.
- A "Tokens" hint listing every token (devmon shows it on hover).
- Same edit permission as the rest of that page.
- One shared partial for the field keeps the pages consistent.

## Several app servers

If the site runs more than one Node process and caches settings per process, a location or account
title change applies at once on the server that saved it and within the cache lifetime on the
others (devmon: 60 s). Column levels are read fresh from the alarm query.

## Schema (portable SQL)

```sql
-- Levels without a settings table. NULL = inherit.
ALTER TABLE devices ADD COLUMN alarm_title VARCHAR(200) NULL;
ALTER TABLE sensors ADD COLUMN alarm_title VARCHAR(200) NULL;
ALTER TABLE alarm_rules ADD COLUMN alarm_title VARCHAR(200) NULL;

-- Site setting, inserted only when missing (do it in the site's seed code if it has one).
INSERT INTO settings (setting_key, setting_value, kind, setting_group, description)
SELECT 'ALARM_TITLE_FORMAT', '{sensor_name} on {device_name} at {location_name}', 'string', 'general',
       'Alarm title: the email subject after the event word, the first line of the SMS and the API alarm name.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'ALARM_TITLE_FORMAT');
```

Account and location titles need no schema change when the site already has scoped settings tables;
they are rows with key `ALARM_TITLE_FORMAT`. Use the site's table prefix and column names.

## Tests

- `pick`: most specific wins, white space only counts as blank, all blank gives the default.
- `render`: tokens fill, unknown tokens stay, missing values blank, line breaks become spaces.
- `duration`: the examples above.
- `tokens`: a threshold alarm, a no data alarm (`no data`, timeout as exceed duration, blanks),
  an alarm with no rule.

---

# Part B: Alarm rule change log

## What it is

Every create, edit and delete of an alarm rule is recorded against **the rule itself**, so one rule's
whole history is one indexed query, deleted rules included. Shown on the sensor's alarm rules page
(a collapsed change history under each rule, and a "Removed rules" panel) and served by an API
endpoint.

## Audit table (portable SQL)

If the site already has a general audit table with these columns, reuse it. Otherwise:

```sql
CREATE TABLE audit_log
(
    id BIGSERIAL PRIMARY KEY,          -- or the site's identity / auto increment form
    epoch BIGINT NOT NULL,             -- seconds; use the site's timestamp type if it has one
    entity_type VARCHAR(16) NOT NULL,  -- 'alarm_rule' for this feature
    entity_uid VARCHAR(36) NOT NULL,   -- the rule's public uid (a UUID column type is fine)
    entity_name VARCHAR(120) NULL,     -- the sensor's name at the time
    field VARCHAR(60) NOT NULL,        -- 'created', 'deleted', or the changed field's name
    old_value TEXT NULL,
    new_value TEXT NULL,
    actor_type VARCHAR(14) NOT NULL,   -- user | api_credential | system
    actor_id INTEGER NULL,
    actor_name VARCHAR(80) NULL        -- username or key name at the time
);
CREATE INDEX ix_audit_log_entity ON audit_log (entity_type, entity_uid, epoch);
```

If the site needs a time range scan across all rules (the API endpoint below) and the table grows
large, add an index on `(entity_type, epoch)`.

## Writing

- One writer function, `audit(trx, entry)`, called **inside the same transaction** as the rule
  change, so a change and its log commit or roll back together.
- Rows are keyed `entity_type = 'alarm_rule'`, `entity_uid = <rule uid>`, `entity_name = <sensor name>`.
- **Create:** one row, `field = 'created'`, `new_value` = the whole rule as JSON (plus an optional
  `reason`).
- **Edit:** one row per changed field, `field` = the field name, old and new values.
  Nothing is written when nothing changed.
- **Delete:** one row, `field = 'deleted'`, `old_value` = the whole rule as JSON (plus `reason`).

Audited fields:

`rule_kind`, `direction`, `threshold`, `severity`, `exceed_secs`, `return_secs`, `timeout_secs`,
`is_enabled`, `use_default_group`, `channel_policy`, `alert_groups`, `alarm_title`

(Use the site's own rule columns; keep the list in one constant.)

How the comparison stays honest:

- **Snapshot from the database both times.** Take a snapshot of the rule (read back from the
  database) before the update, update, snapshot again, compare. Form values ("1", "on") and
  database values (true, 1) then always compare alike. On PostgreSQL, BOOLEAN columns come back as
  true and false: normalize booleans to 1 and 0 in the snapshot.
- **Compare as text**, NULL as NULL.
- **Store values as the database holds them** (thresholds in the canonical unit); pages convert
  for display.
- **A NULL channel policy means all on.** Store it in the snapshot as the explicit all on JSON the
  form writes, so the first save of an untouched rule is not logged as a change.
- **Alert groups** are recorded as their names, sorted, joined with ", ".

Actors:

- A person: `user`, their id and username.
- An API key: `api_credential`, its id and name.
- The system: `system`, used for rules created automatically (devmon: a device type's default rules
  when a sensor appears, reason `device type default`).

Deletes from elsewhere: deleting a sensor or a device logs each of its live rules as deleted
(reason `sensor deleted` or `device deleted`) through one helper, then marks the rules deleted.

If the site has an activity log, also write `alarm_rule_created`, `alarm_rule_updated` (detail
lists the changed fields) and `alarm_rule_deleted`.

## Reading back

One module turns audit rows into lines a person can read: `{ epoch, who, what, before, after }`.

- **who:** `System`, `API key <name>`, or the username.
- **what:** `Created`, `Deleted`, or a label per field:

| Field | Label |
|---|---|
| rule_kind | Kind |
| direction | Direction |
| threshold | Threshold |
| severity | Severity |
| exceed_secs | Exceed delay |
| return_secs | Return delay |
| timeout_secs | No data timeout |
| is_enabled | Enabled |
| use_default_group | Default group |
| channel_policy | Channels |
| alert_groups | Alert groups |
| alarm_title | Alarm title |

- **Values:** threshold converted to the page's display unit with its unit; direction `Above` or
  `Below`; kind `Threshold` or `No data`; delays and timeout in minutes; switches `on` or `off`;
  channel policy summarized per transition (`Raise email+SMS, Escalate off, ...`); blank is `--`
  (alert groups blank is `none`).
- **Created and deleted rows** show the whole rule in one line, for example
  `Above 46.4 F, alarm, exceed 5 min, return 5 min, groups: Night crew (device type default)`.

Sensor page:

- Under each live rule, a collapsed "Change history", newest first.
- A "Removed rules" panel: each deleted rule, its summary, when it was removed, and its history.
- Read with one query: audit rows where `entity_type = 'alarm_rule'` and `entity_uid` in this
  sensor's rule uids (live and deleted), newest first.

## API endpoint

`GET /alarm-rules/changes?from=&to=&location=&device=&sensor=&limit=` (read permission):

- Audit rows of type `alarm_rule` between `from` and `to`, oldest first, joined through the rule to
  its sensor, device and location for the visibility check (deleted rules, sensors and devices
  included, so a removed limit still shows who removed it).
- Each change: `epoch`, `rule`, `sensor`, `sensor_name`, `device`, `device_name`, `location`,
  `change` (`created`, `deleted` or the field name), `old_value` and `new_value` typed (numbers,
  booleans, the policy and whole rule snapshots as objects), `old_display` and `new_display` from the
  read back module so the API and the page word a change the same way, and `actor { type, name }`.
- Paged by epoch: fetch `limit + 1`; when there are more, stop before the epoch that could not be
  finished and return `truncated: true` with `next_from` set to that epoch. The caller asks again
  with `from = next_from` until `truncated` is false. No row is skipped or repeated even when several
  share an epoch. Only a whole page inside one second cannot be split; then `next_from` moves one
  second on. Default limit 500, max 1000.
- uids in the path or query are checked against a UUID pattern before any query, so a malformed
  uid is a 404, not a database error.

---

## PostgreSQL notes

- Use `VARCHAR(n)` or `TEXT`, `BIGINT`, `BOOLEAN`, `BIGSERIAL` or `GENERATED ... AS IDENTITY`.
  Nothing here needs engine specific features.
- Read inserted ids the way the site already does (`RETURNING id`).
- UUIDs: compare as lower case strings in code so pages, API and audit rows always match.
- JSON snapshots can be TEXT; JSONB works too, but compare as text when detecting changes.
- Keep list pages bounded (the 1000 limits above) even though PostgreSQL allows many more bound
  parameters than SQL Server.

## Suggested build order

1. Schema: the `alarm_title` columns and the site setting (and the audit table if missing).
2. Resolver module and its unit tests.
3. Notifications: subject, SMS first line, stored subject, fallback.
4. Site setting on the admin page, title field in the rule form.
5. Title fields on the sensor, device, location and account settings pages.
6. API `name` and API docs.
7. Rule change log writer, wired into rule create, edit, delete and sensor or device delete.
8. Sensor page change history and Removed rules panel.
9. API change log endpoint and docs.
10. Decisions log entries.

Steps 7 to 9 do not depend on 1 to 6; the change log can go first if the site needs it sooner.
Once both exist, add `alarm_title` to the audited fields.

## Decisions to record on the target site

- Title used in subject (after the event word), SMS first line and API `name`, from one resolver.
- The override order and where each level stores its title.
- No data alarms use the same chain and tokens.
- Token list and meanings; unknown tokens left as typed.
- Values use the API's display unit lookup.
- Rule changes audited against the rule, one row per changed field, snapshots from the database,
  NULL policy as all on.
