# Administration > Users: port guide

Built and settled on voltastc (Oct 2026). This document describes the Administration > Users pages
so they can be added to another site built from the same platform (devmon, DTM, or any site that
follows the iot-platform skill). It is written to be handed to Claude (or a developer) working in
the target repo, as the spec for the work. voltastc's `DECISIONS.md` section "Administration >
Users" is the short form; this is the long form with the reasons and the order of work.

## How to use this document

1. Read the target site's own decisions log, structure notes, `routes/admin.js`, `routes/auth.js`,
   `middleware/auth.js`, the profile route and view, the account users route and view, and its
   migrations for the `users` and `grants` tables. Where the site already settled something that
   conflicts with this guide, stop and ask; do not overwrite it.
2. Check what the target has (next section) and say which cards apply before writing anything.
   A site without MFA, chart email or SMS leaves those parts out.
3. Agree the four choices under "Agree first" with Jeff.
4. Build in the steps below, one file or one concern at a time, with review between steps. Each
   step is small enough to read as one diff.
5. Record the decisions in the target's decisions log and structure notes (step 8).

A prompt to start the work on another site:

> Read ADMIN_USERS_README.md (attached or in the repo) and this site's decisions log and
> structure notes. Add Administration > Users following the guide. First tell me what this site
> already has from the "What the target site must have" list, which cards apply, and any conflict
> with this site's decisions, then ask me the "Agree first" questions. Then build it in the guide's
> steps, one reviewed step at a time.

## What it is

Superadmins get a Users item under Administration (after Accounts):

- **`/admin/users`**: every live user, searched, sorted and paged on the server. Search on
  username, name and email. Sort on user, name, email, access, last login, chart emails, status.
  25 a page. Search, sort, direction and page are GET parameters, so a view is a link.
- **`/admin/users/<uid>`**: one user, four cards, and a **Show all activity** link in the header
  that opens the event log filtered to the user.
  - **Sign in:** active or offline (no sign in, no email or SMS) with a button to change it, the per user MFA dropdown, last
    login, password set, created, and **Send reset link**.
  - **Alerts:** alarm email on or off (SMS too, where SMS is part of the site). The user can turn
    either back on in their own profile.
  - **Chart email:** sent in the last 24 hours against the daily limit; a permanent limit and a
    one time limit for the next 24 hours.
  - **Access:** every account and location grant with its permissions; Edit, Remove, Add access.

Every action posts to `/admin/users/<uid>/<action>`, changes one thing, writes an audit row per
changed field and an event log row, then redirects back to the page with a confirmation. A value
that did not change saves nothing. Send reset link changes nothing on the user, so it writes only
its event.

## What the target site must have (check, do not assume)

Report each as present, absent, or different:

- `users` with `uid`, `username`, `display_name`, `email`, `is_superadmin`, `last_login_epoch`,
  `password_changed_epoch`, `must_set_password`, `created_epoch`, `delete_epoch`,
  `email_enabled`, `sms_enabled`, `email_bounced`, `email_paused_until_epoch`.
- `grants` (`grantee_type`, `grantee_id`, `scope_type` account or location, `scope_id`,
  `permission_bits`) with a unique index on the grantee and scope, and `permissions.js` with
  `BITS`, `ALL`, `bitsOf`, `has`, `names`.
- An audit helper (`services/audit.js` `audit(trx, {...})`) and the event log
  (`services/activity.log(req, event, fields)`).
- `notFoundError()` (`middleware/errors.js`), `uidParam`, `intParam`, `isUuid` (`middleware/account.js`) and
  `isUniqueViolation()` (`db/knex.js`).
- Forgot password with a reset link that is only consumed by its confirm POST, and `loadUser`
  that ends sessions for deleted users.
- The nav menu with an Administration group (`nav/menu.js`) and the `iot-sortable` header CSS.
- The table tools (`public/js/iot-table-tools.js`), which add a Download button to every
  `iot-table` unless it has `data-tools="none"`, and the CSS rule that keeps that button beside a
  header control marked `iot-header-end`:
  `.iot-panel__header .iot-header-end + .iot-table-dl { margin-left: 0 !important; }`. Add the
  rule if the target lacks it.
- An event log viewer with a user filter in its URL (voltastc: `/admin/logs?range=30d&who=u<id>`).
  Note its parameter names and longest period.
- Optional parts, each with its card or field:
  - MFA sign in codes (`users.mfa_mode`, `services/mfa.js`, `POST /admin/users/<uid>/mfa`).
  - Chart email from the site (`chart_emails`, `users.chart_email_daily_limit`, `limitFor()`).
  - SMS, and whether it is hidden (voltastc: `mfa.SMS_VISIBLE = false`).
- The database: PostgreSQL (voltastc) or SQL Server (some DTM sites). See "SQL Server" below.
- The site's status code convention (voltastc uses real status codes; check before using 403).

## Agree first

voltastc's answers are in brackets. Ask; do not assume they carry over.

1. **SMS switch:** build it behind the site's SMS visibility flag, or show it now? [behind the
   flag; hidden today]
2. **Offline:** stops signing in only, or also every email and SMS? [everything: Jeff first chose
   sign in only, then changed it, because an offline user cannot sign in to turn anything off.
   Recommend everything.]
3. **One time chart email limit:** a new limit for the next 24 hours that replaces the normal one,
   or extra sends added on top? [replaces, 24 hours]
4. **Per user MFA dropdown:** keep it on Account > Users too, or only on the admin page? [both]

## Step 1: migration

Forward only, next number on the target. voltastc's `0014_admin_users.sql`:

```sql
ALTER TABLE users ADD COLUMN disabled_epoch BIGINT NULL;
ALTER TABLE users ADD COLUMN disabled_by INTEGER NULL;
ALTER TABLE users ADD COLUMN chart_email_limit_once INTEGER NULL CHECK (chart_email_limit_once >= 0);
ALTER TABLE users ADD COLUMN chart_email_limit_once_until BIGINT NULL;
ALTER TABLE users ADD CONSTRAINT ck_users_chart_email_limit_once
    CHECK ((chart_email_limit_once IS NULL) = (chart_email_limit_once_until IS NULL));
```

Leave out the two chart email columns on a site without chart email. No defaults, so existing rows
need no update. Use the target's own prefix rule for table names. Write the migration's header
comment the way the target's other migrations are written.

## Step 2: menu item and the list

- `nav/menu.js`: `{ label: "Users", path: "/admin/users" }` after Accounts.
- `routes/admin.js` `GET /users`, behind the router's superadmin gate:
  - Read and clamp the parameters: `q` (trimmed, 80 at most), `sort` (only a key of
    `USER_SORTS`, else `user`), `dir` (`asc` or `desc`), `page` (whole number, 1 or more; past
    the last page shows the last page).
  - `USER_SORTS` maps each sort key to fixed SQL, so nothing from the query reaches
    `orderByRaw`:

    ```js
    const USER_SORTS =
    {
        user: "u.username",
        name: "u.display_name",
        email: "u.email",
        access: "grant_count",
        login: "u.last_login_epoch",
        shares: "shares_24h",
        status: "(u.disabled_epoch is not null)"
    };
    ```

    Postgres can sort by a bare output alias (`grant_count`) but not by an expression built from
    aliases, which is why `grant_count` is its own column rather than `account_grants +
    location_grants`. Sort with `orderByRaw(sql + " " + dir + " nulls last")`, then by username.
  - Search: `ilike` on username, display name and email, with `%`, `_` and `\` escaped in the
    input (the same escape Add existing users uses).
  - Counts come in the same query as the rows, as subqueries, and **leave out grants on deleted
    accounts and locations** (a location grant needs both the location and its account live),
    so the list agrees with the user page:

    ```js
    const ACCOUNT_GRANTS = "(select count(*) from grants g join accounts a on a.id = g.scope_id" +
        " where g.grantee_type = 'user' and g.grantee_id = u.id and g.scope_type = 'account' and a.delete_epoch is null)";
    const LOCATION_GRANTS = "(select count(*) from grants g join locations l on l.id = g.scope_id join accounts a on a.id = l.account_id" +
        " where g.grantee_type = 'user' and g.grantee_id = u.id and g.scope_type = 'location' and l.delete_epoch is null and a.delete_epoch is null)";
    ```

    Chart emails: `count(*)` of `chart_emails` rows with outcome `sent` in the last 86400 s.
  - One `count(*)` with the same filter for the total; 25 rows with `limit` and `offset`.
- `views/admin/users.ejs`: a GET search form (carrying sort and direction as hidden fields), the
  table, and "1 to 25 of N users" with Previous and Next. Each sortable header is
  `<th class="iot-sortable" aria-sort="...">` holding a link; clicking the current column flips
  the direction and goes back to page 1. Do not add `is-sortable`: `iot-sort.js` would re-sort
  one page in the browser. Give the table `data-tools="none"`: the table tools' Download would
  export only the 25 rows on screen, which reads as the whole list. Columns: user (link, superadmin badge), name, email, access ("2
  accounts, 1 location"), last login (`fmt.ago`), MFA ("Inherit (site on|off)", On, Off), chart
  emails ("3 of 20"), active (green) or offline (grey). Say "active", not "online": on voltastc "online" read as "signed in right now".

## Step 3: the user page, read only

`GET /users/:uid` (the uid checked by `uidParam`). A missing or deleted user is `notFoundError()`.
Load:

- Account grants joined to live accounts, and location grants joined to live locations and their
  live accounts; sort by account name, the whole account grant first, then its locations. Mark
  a grant holding every bit as "Full access".
- Chart emails sent in the last 24 hours and `limitFor(user)`.
- The superadmin who put the user offline (`disabled_by`), if any.
- `navTrail`: Administration / Users / username.

Show the four cards and the Access table, with no forms yet. Times in the target's admin
convention (voltastc: UTC with "ago", like the firmware page).

- **Dark theme:** the small label and value tables inside the cards are
  `<table class="table table-sm iot-table mb-0" data-tools="none">`. A plain Bootstrap
  `table table-sm` draws a light background on the dark theme (seen on voltastc's first deploy);
  `iot-table` takes the theme, and `data-tools="none"` keeps a Download button off them. Use the
  target's theme variables for any color; no hard coded light backgrounds.
- **Show all activity:** a link in the header line, beside the active or offline status:
  `/admin/logs?range=30d&who=u<user id>` on voltastc (the longest period the log offers). Use the
  target's own filter names. Tell Jeff what it shows: the log's user filter matches the **actor**,
  so it lists what the user did (requests, sign ins, refused sign ins while offline) but not what
  a superadmin did to them on this page (those rows are under the superadmin), nor failed
  passwords (logged under the name typed). voltastc accepted that; widening it means changing the
  event log's filter, a separate piece of work.

## Step 4: reset link, MFA dropdown, alerts

- **Reset link.** Move the reset email out of Forgot password into one function both use
  (voltastc: `services/resetLink.js` `send(user)`, returning the mail service's answer), with the
  text unchanged. `POST /users/:uid/reset-link` sends it, says the provider's reason when the send
  fails, and writes `password_reset_sent`. Never show the link to the superadmin.
- **MFA.** Reuse the existing override route. Widen its `back` check to exactly two shapes, so it
  stays no open redirect:

  ```js
  /^\/(account\/[0-9a-f-]{36}\/users|admin\/users\/[0-9a-f-]{36})$/i
  ```

  The dropdown saves on change, as on Account > Users.
- **Alerts.** `POST /users/:uid/alerts` takes `email_enabled`, and `sms_enabled` only while SMS is
  part of the site, so a crafted post cannot turn on a hidden channel. The profile gets the matching
  "Send me alarm text messages" switch behind the same flag; email already has one. One audit row
  per changed field, event `user_alerts`.

## Step 5: offline

`disabled_epoch` set means offline: no sign in and no email or SMS of any kind. It is not a
delete. The user's own alert switches are overridden, never changed, so making them active again
brings their choices back.

**Sending:** find every place that sends to a user first (grep the target for `mail.send(`,
`sms.send(` and its recipient queries), then:

- **`mail.send()`:** when `recipientType` is `user` and the user is offline, write the
  notifications row and mark it `suppressed`, reason `user offline`, and return
  `{ ok: false, suppressed: true }` without sending. One check covers report emails, device
  access requests, the added to an account email, support copies and anything added later.
- **Alarm gate** (`services/alarms/notify.js` `gate()`): return `user offline` first in the
  user branch, for email and SMS, so no action link or chart is built and the alarm's
  notification history says why.
- **Group mail addressed as plain addresses** (voltastc: support handler emails, one message to
  the whole group): leave offline users out where the list is built.
- **Anything with its own recipient log** (voltastc: `support_recipients`, whose outcome allows
  only sent or failed): skip the offline user before sending, at the check that already skips
  deleted and bounced users, so the log never shows a false failure.

**Sign in:**

- **Password step:** check offline only **after** the password is right, so the message tells
  nobody who lacks the password. Answer 403 with "This account is turned off. Contact your
  administrator.", event `login_refused` (detail `user offline`). Do not write `login_failed`: it
  is not a failed attempt and must not count toward the lockout.
- **Sign in code step and resend:** reload the user (both already do); if offline, drop the
  pending sign in and show the same message.
- **Reset link, both GET and POST:** treat as a dead link (the usual friendly page), logged with
  the reason `user offline`.
- **Forgot password:** send nothing, show the usual page (enumeration safe), and log it.
- **`loadUser`:** add `user.disabled_epoch` to the conditions that destroy the session. Test the
  value for truth, not `!== null`, so a process running before the migration does not sign
  everyone out.
- **Admin route** `POST /users/:uid/offline` with `action` `offline` or `online`: refuses the
  superadmin's own account (and the page hides the button), writes `disabled_epoch` and
  `disabled_by`, audit field `status`, events `user_offline` and `user_online`. Confirmations:
  "<user> is offline and cannot sign in." and "<user> is active again."
- **Wording on the page:** the status says **Active** (green) or **Offline since <when> by <who>**
  (grey). The buttons are **Put offline** (with the help text "They cannot sign in, any open
  session ends, and they get no email or SMS. Their alert settings are kept for when they are
  active again.") and **Make active**. Only what people read says "active"; the `online` action
  value, the `user_online` event, the audit value and the status CSS class keep the old word, so
  the history does not split across two names.
- **Alerts card:** for an offline user it adds "Nothing is sent while they are offline." after
  the profile note, so nobody reads the switches as what will happen.
- **Send reset link** refuses an offline user (the link would not work) and the button is greyed.

Known gap, accepted on voltastc: the live feed (socket.io) checks the user only on connect, so a
page already open keeps updating until the next click. Deleted users have the same gap.

API keys are their own identity and are not affected.

## Step 6: chart email limits

`POST /users/:uid/chart-limit` with `kind`:

- `permanent`: `chart_email_daily_limit`; blank goes back to the site setting.
- `once`: `chart_email_limit_once` and `chart_email_limit_once_until = now + 86400`. Setting it
  again starts a fresh 24 hours.
- `end_once`: clears both.

Whole numbers 0 to 10000; 0 turns sending off. `limitFor()` gains the one time limit first:

```js
function limitFor(user, now)
{
    const at = now || Math.floor(Date.now() / 1000);
    if (user.chart_email_limit_once !== null && user.chart_email_limit_once !== undefined && Number(user.chart_email_limit_once_until) > at) { return Number(user.chart_email_limit_once); }
    if (user.chart_email_daily_limit !== null && user.chart_email_daily_limit !== undefined) { return Number(user.chart_email_daily_limit); }
    return Number(settings.get("CHART_EMAIL_DAILY_LIMIT", 20));
}
```

The send passes its own `now`. A lapsed one time limit is ignored, never cleared by a job.
`Number()` matters: the pg driver returns BIGINT as a string. The confirmation states the limit
that now applies.

## Step 7: access

- `router.param("grantId", intParam)`.
- `POST /users/:uid/grants` adds access. The select's values are `a:<account uid>` (whole
  account) or `l:<location uid>`, checked with `isUuid()`; a deleted account or location (or a
  location whose account is deleted) is refused. At least one permission. No ceiling: only
  superadmins reach this page. An existing grant at the scope is refused with "use Edit"; the
  insert also catches `isUniqueViolation()` for two adds at once (outside the transaction: in
  Postgres nothing else may run in a transaction after a caught error).
- `POST /users/:uid/grants/:grantId` edits or removes (`action=remove`). The grant must belong to
  this user or it is not found. An edit with no permissions is refused ("or use Remove"). Each
  change and its audit row go in one transaction.
- Audit rows use Account > Users' fields, so the history reads the same from both pages:
  `grant_added` (`<scope>:<id> <names>`), `grant_<scope>:<id>` (old names to new names),
  `grant_removed`. Events `user_added`, `grant_changed`.
- View: the Add access button sits in the Access panel header with `ms-auto iot-header-end`, so
  the table tools' Download (kept on this table) lands right beside it instead of splitting the
  free space and leaving the button in the middle. Add access opens a panel with the account and location select (an optgroup per account:
  "whole account", then its locations) and the permission checkboxes, View ticked. Each grant row
  has Edit, which opens its checkboxes with Save and Remove (Remove confirms, as on Account >
  Users).

## Step 8: documents

- Decisions log: a section "Administration > Users" (voltastc's is the model), and updates to
  the entries this touches: where the MFA override lives, the chart email daily limit, and the SMS
  hidden rule if the SMS switch was built behind the flag.
- Structure notes: the migration, the reset link function, the admin routes, this guide.

## SQL Server targets

- No `ilike`: use `LIKE`; the users columns are usually case insensitive by collation already.
  Escape `[` as well as `%` and `_`, or use `ESCAPE`.
- No `NULLS LAST`: sort with `CASE WHEN col IS NULL THEN 1 ELSE 0 END, col dir`.
- No `::int` casts (`COUNT` is already `int`). `OFFSET ... FETCH` needs an `ORDER BY`, which the
  list always has.
- The duplicate error is 2627 or 2601; use the target's own `isUniqueViolation()`.
- `BIT` columns come back as booleans or 0 and 1 depending on the driver; compare with `!!`.

## Checking it

On the target, as a superadmin:

1. The list: search for part of an email; sort each column both ways; page past the end; open a
   shared link with all four parameters. A user with a grant on a deleted account counts it on
   neither page.
2. Send reset link to a test user: one email, the same text as Forgot password; the link works.
3. MFA dropdown on the user page returns to the user page; on Account > Users it still returns
   there.
4. Alerts: turn email off; the user sees the profile switch off and can turn it back on; an alarm
   skips them while off (notification row "email turned off by user").
5. Put a test user offline while they are signed in elsewhere: their next click lands on the sign
   in page; their password gives the turned off message; a wrong password gives the usual one;
   Forgot password sends nothing; an old reset link shows the dead page. Raise an alarm that
   would email them: its notification history says `user offline`. Run a report they receive:
   the send log shows it suppressed. Make them active again: all work, and their alert switches
   are as they left them. Your own page has no Put offline button.
6. Chart email: set a one time limit of 1, send twice (the second is refused with 429), End one
   time limit, send again. Set a permanent 0: sending is off.
7. Access: add a location grant, edit it, add the same again (refused), remove it. The audit
   history on Account > Users shows the same rows.
8. The event log shows each action under its event name.
9. Dark theme: no light table backgrounds on the user page; the Users list has no Download; the
   Access header has Add access then Download at the right.
10. Show all activity opens the event log filtered to that user.

## Suggested build order

The steps above, in order. Steps 1 to 3 can be deployed together and show a working read only
page; each later step is independent of the others except that step 5 also touches the reset
link button from step 4.
