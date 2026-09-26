# devmon (DTM IoT monitoring platform)

Multi tenant IoT monitoring platform for datatelematics: Node/Express/EJS, SQL Server,
Mosquitto MQTT. Production is an IIS farm (iisnode) behind the customer's ARR.

## Read before changing anything

1. `DECISIONS.md`: settled decisions and their reasons. Do not reverse one silently.
2. `STRUCTURE.md`: one line per folder, where things live.
3. `.claude/skills/iot-platform/`: the architecture reference the code follows.

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
- The `DTM_` table prefix lives only in `T()` in `db/knex.js`.
- Deny access only with `notFoundError()` (denied and missing look identical).
- Use `insertId()` to read `.returning()` results.
- `PORT` is a named pipe under iisnode: pass it to `listen()` untouched, never
  `Number(PORT)`, never bind a host.
- Migrations are forward only T-SQL. Never edit an applied migration; add a new one.
- Inline page scripts run on `DOMContentLoaded` (vendor libraries load at end of body).
- Use theme variables for colors; no hard coded light backgrounds.
- Ingest and jobs run only on the leader (`services/leader.js`). Anything that notifies,
  writes alarms, or runs on a schedule must stay behind that gate.
- Never rotate `SETTINGS_KEY`.
- MQTT connection settings come from site settings through `mqtt/broker.js` only.

## Environment and secrets

- `.env` holds production values. Do not read, edit, or print it.
- Dev uses `.env.local`. After changing it:
  `docker compose up -d --force-recreate app` (restart does not reread it).
- Never point dev at the production database (`dtmprod`) or reuse production's MQTT
  client id.
- Do not touch the broker host, IIS servers, or `deploy/web.config` unless asked.

## Git

- Deploy is by push: pushing is a production deploy.
- Do not commit, push, or change branches. Jeff reviews and commits.

## Commands

- Start dev: `docker compose up -d`
- Logs: `docker compose logs -f app`
- Unit tests (node:test): `node --test tests/*.test.js`
- Health check: `curl http://localhost:<port>/health`
