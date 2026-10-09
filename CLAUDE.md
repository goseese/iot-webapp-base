# IoT web app base (iot-webapp-base)

The generic base for GSE's customer IoT monitoring sites: each site is a fork or mirror of this
repo. Node 22 / Express / EJS, PostgreSQL on RDS, Mosquitto with dynamic security, one Ubuntu 26.04
EC2 server per site (nginx in front, pm2 running a `web` and an `ingest` process). Mirrored from the
Voltastc app (itself a copy of the devmon (DTM) IoT platform) and made generic; both steps are
recorded in `DECISIONS.md`.

Every site specific name comes from the installer: the site name slug `APP_SLUG` (`<slug>` below:
`/opt/<slug>`, the app user, the broker logins, the session cookie), the domain, the `SITE_NAME`
and `THEME_PRIMARY` settings, and the logo files in `public/img/`. Never hard code a site's name,
domain or slug.

## Read before changing anything

1. `DECISIONS.md`: settled decisions and their reasons. Do not reverse one silently.
2. `STRUCTURE.md`: one line per folder, where things live.
3. The iot-platform skill: the architecture reference the code follows. Where this app deviates,
   `DECISIONS.md` says so and wins.
4. `dynsec-broker-summary.md` (broker and provisioning, server side), `device-provisioning.md`
   (the same from the firmware side) and `command-protocol.md` (queued commands, firmware updates,
   JSON relay frames).
5. `docs/port-guides/` holds the port guides (`*_README.md`): specs written while a feature was built on Voltastc or
   devmon, for porting it to other sites. They are history; where one differs from `DECISIONS.md`
   or the code, those win.

If a request conflicts with a decision or the skill, stop, name the entry, and ask before
deviating. When a change alters or adds a decision, add an entry to `DECISIONS.md`. When a
folder's role changes, update its line in `STRUCTURE.md`.

## How Jeff works

- Discuss the problem and agree on a plan before writing code.
- Make changes in small, reviewable steps, one file or one concern at a time, and wait
  for review before the next step.
- Solve the immediate problem first. Refactor only when asked.
- No unrequested refactors, renames, reformatting, or "while I'm here" cleanups.
- Consult the source: library code in `node_modules`, official docs, datasheets. Do not
  guess at an API or a fix; say so when something is unverified.
- When there are choices, offer at most two or three, briefly.
- Allman style braces in all code.
- No em dashes anywhere: prose, comments, docs, commit messages, emails.

## Hard rules (details in DECISIONS.md)

- MQTT topics live only in `mqtt/topics.js`.
- Tables have no prefix; `T()` in `db/knex.js` is a pass through kept so every query goes through
  one place.
- Deny access only with `notFoundError()` (denied and missing look identical).
- Ids from URLs, queries and bodies are checked before they reach a query: a router with ids in its
  paths has `router.param("uid", uidParam)` (or `intParam`) from `middleware/account.js`, and posted ids
  go through `isUuid()`. Postgres turns a malformed id into a 500 otherwise.
- Use `insertId()` to read `.returning()` results; use `isUniqueViolation()` to catch a duplicate.
- Postgres aborts a transaction on any error: inside `knex.transaction` never run another statement
  after a caught error; use a savepoint (`trx.transaction`) if one is ever needed.
- Migrations are plain `NNNN_name.sql` files, forward only once production has them. A literal `?`
  in a migration is written `\?` (knex rewrites `?` to `$n`). No `CREATE INDEX CONCURRENTLY`.
- Real HTTP status codes everywhere; firmware reads the status line.
- Inline page scripts run on `DOMContentLoaded` (vendor libraries load at end of body).
- Use theme variables for colors; no hard coded light backgrounds.
- Ingest and jobs run only in the `ingest` process (`services/leader.js`). Anything that
  notifies, writes alarms, or runs on a schedule must stay behind that gate.
- The site name comes only from `config/settings.siteName()` (the `SITE_NAME` setting).
- Never rotate `SETTINGS_KEY`.
- MQTT connection settings come from site settings through `mqtt/broker.js` only.
- Passwords never go on a command line (ps shows argv); pass them in the environment or on stdin.

## Environment and secrets

- `.env` and `.env.*` are gitignored; `.env.example` is the committed template. On the server
  `deploy/install.sh` creates `/opt/<slug>/.env` (root:<slug>, mode 640) from the answers to its
  questions. Do not read, edit, or print a real `.env`.
- Broker passwords live in `/etc/<slug>/broker.env` on the server (root only).
- Dev setup is an open question (a Postgres container in docker-compose, or a dev database on
  RDS). `docker-compose.yml` runs the app and a Mosquitto but no Postgres yet. Never point dev at the
  production database or reuse production's MQTT client id.

## Git and deploy

- Do not commit, push, or change branches. Jeff reviews and commits. Read only git commands only
  (`git --no-optional-locks ...`); never touch the index.
- Deploy: push, then on the server
  `cd /opt/<slug> && sudo git pull && sudo bash deploy/install.sh`
  (safe to repeat: npm ci, migrate, seed, broker check, pm2 reload; secrets and data are kept).
  A bare `pm2 reload` is fine only when the pull brings no migration: a web process that finds a
  pending migration stays on the 503 page until restarted.

## Commands (on the server)

- pm2 as the app user must run from a folder that user can enter:
  `cd /opt/<slug> && sudo runuser -u <slug> -- pm2 list` (also `pm2 logs`, `pm2 reload all`).
  From your home folder pm2 fails with `spawn /usr/bin/node EACCES`.
- Health: `curl -s http://127.0.0.1:3000/health`
- Operator scripts: `cd /opt/<slug> && sudo runuser -u <slug> -- node scripts/<name>.js`
  (`scripts/broker-bootstrap.js` also needs `APP_SLUG=<slug>` in front)
- Database: `psql "host=<RDS endpoint> port=5432 dbname=<slug> user=<user> sslmode=require"`
- Broker log: `sudo tail -f /var/log/mosquitto/mosquitto.log`
- Unit tests (node:test): `npm test`
