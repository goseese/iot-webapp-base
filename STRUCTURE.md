# devmon source map

One line per folder. The architecture the code follows is the iot-platform skill; settled
deviations for this install are in deploy/README.md and DECISIONS.md.

- `app.js` boot: HTTP listens first, then database, migrations, seeds, settings, then the leader lock starts ingest and jobs on whichever instance holds it. `/health` reports build, host, pid and leader. `index.js` is the iisnode entry (requires app.js).
- `config/` env (typed .env), settings cache with env override and secret encryption, logger, build identity.
- `db/` knex instance (`T()` prefixes tables with DTM_, `insertId()` normalises inserts), migrations runner, shadow sync of device types, repos (thin SQL per table; `credentials.js` is the one place to find a unit's broker identity, by MAC or GUID, and a unit's current placement).
- `migrations/` forward-only T-SQL, applied at boot.
- `seeds/` idempotent: site settings (grouped, driver-declared), known lists, superadmin, System account, default alert groups.
- `permissions.js`, `metrics/`, `deviceTypes/`, `reportTypes/`: code-owned declarations the database shadows. A device type module also declares the gateway `configKeys` (Config tab) and `commands` (Commands tab).
- `mqtt/` topic table (`topics.js`, the only place topics live), broker settings (`broker.js`, from site settings; `watch.js` reconnects within 15 s when they change) the ingest client (fixed `MQTT_CLIENT_ID`, leader only) and `downlink.js` (server to device publishes through whichever connection the process has, never retained).
- `pipeline/` stage 1 (identify: topics, registry, coverage, dedup, where unplaced MACs are heard, auto claim) then stages 2..6 in index.js (insert, hooks, signals, alarms, publish); `levels.js` adds battery and signal percent before insert.
- `services/` business logic: leader (SQL applock `devmon-leader` on its own tedious connection; gates ingest and jobs across the farm), alarms (ladder, engine, notify, nodata, escalation, actions, armed), mail and sms drivers, broker drivers (static and dynsec, chosen by the `BROKER_DRIVER` setting), provisioning, connectEndpoint (retained con/endpoint message), unitConfig and configValues (gateway config: reported values, pending writes, re-send on connect), levels (battery chemistry and radio signal percent tables), devices (also `createSensor`, sensors are created on first value) and deviceFlows, grants, invites, reports, webhooks, display, visibility; unclaimed (unclaimed devices per account: list, ignore, claim names) and autoClaim (auto claim mode: claim on hear, expiry).
- `jobs/` minute and daily schedulers and their tasks (server stats, purge, offline periods, auto claim expiry, con/endpoint refresh, broker audit, never-connected unit cleanup); started only on the leader.
- `routes/` one router per area; `routes/account/` one file per account page, `list.js` is `/account` and the rest mount under `/account/<account uid>` along with the Analytics and Reports list pages (`unclaimed.js` also renders the location's Unclaimed view); `routes/api.js` bearer API mounted before sessions; `routes/provision.js` unauthenticated device first contact, mounted above it.
- `middleware/` session, csrf, auth chain (loadUser, requireBits), current account and location (from the URL or the loaded entity, never the session), errors (`notFoundError()` for denied-or-missing), httpStatus (sends every reply as 200; see DECISIONS).
- `nav/` menu tree (Monitor built per location) and breadcrumb builder, both unit tested.
- `realtime/` socket.io relay of the acct/ MQTT feed to the browser (`data` readings, `config` notices); runs on every instance with client id `<MQTT_CLIENT_ID>-web-<host>-<pid>`; `start()` attaches socket.io before listen, `connectFeed()` connects to the broker after settings load; `feedClient()` lends that connection to `mqtt/downlink.js`.
- `views/` EJS: `layouts/` shell, `partials/` shared pieces, one folder per area.
- `public/` theme css/js (`live.js` realtime hooks, `iot-table-tools.js` export/copy, `iot-bulk.js` bulk actions on list tables, `iot-sort.js` column sorting for `table.is-sortable`), vendor libs.
- `tests/` node:test unit tests for the pure parts (ladder, frames, nav, breadcrumb, metrics, permissions, passwords, tags, armed, topics and device ACLs). Run `node --test tests/*.test.js`.
- `scripts/` operator scripts run from a workstation against the database and broker in `.env`: migrate, seed, create-db, add-gateway, `provision-test.sh` (walks a unit through first contact), `reset-test-unit.js` (removes a test unit completely; locally administered MACs only, dry run by default).
- Root docs: `DECISIONS.md` (settled decisions), `STRUCTURE.md` (this file), `dynsec-broker-summary.md` (broker and provisioning design), `leader-lock-summary.md`, `device-provisioning.md` (firmware guide to provisioning and reconnection).
- `deploy/` iisnode web.config and README for this customer; ARR + pm2 alternative kept alongside.
