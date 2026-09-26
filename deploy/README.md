# Deploying devmon to the IIS box (iisnode)

The server admin runs the app with iisnode: IIS hosts Node, `index.js` is the entry and requires
`app.js`. One Node process, `ROLE` unset, so web, MQTT ingest, realtime and the jobs run together.

Files the deploy needs from the repo: everything except the docker dev files (already ignored),
plus `deploy/web.config` copied to the site root as `web.config`. `index.js` is committed.

Order on the box:

1. `.env` in the site root (copy `.env.example`): `NODE_ENV=production`, `APP_URL=https://devmon.datatelematics.io`,
   the `DB_*` values (login from `deploy/create-app-login.sql`), no MQTT keys (those are set after first login
   on Admin > Site settings > MQTT: host `iot.datatelematics.io`, port 8883, TLS on, user `devmon_server`,
   client id `server-devmon.datatelematics.io`), fresh `SESSION_SECRET` and `SETTINGS_KEY`
   (`openssl rand -hex 32` each), the SendGrid key. Do NOT set `PORT`; iisnode provides it.
2. `npm ci --omit=dev`
3. `npm run migrate` then `npm run seed` (the first seed prints the superadmin one time password to the console; keep it).
4. Site root gets `web.config` from `deploy/`. First runs: `devErrorsEnabled="true"` shows startup errors in the browser; turn it off once stable.

IIS settings that matter for this app (the admin):

- App pool: Start Mode `AlwaysRunning`, Idle Time-out `0`, and Preload Enabled on the site. Otherwise IIS
  only starts Node on the first request and stops it when idle, which drops the MQTT connection and the
  minute jobs.
- App pool identity needs read on the site files, write on `iisnode\` (logs) and `storage\` (report files),
  and network access to SQL Server and iot.datatelematics.io:8883.
- IIS WebSocket Protocol feature installed but the site's `<webSocket enabled="false" />` left as is
  (iisnode does the upgrade for socket.io).
- URL Rewrite installed (the web.config rules need it).

Logs: `iisnode\` under the site root (stdout/stderr per process); the app logs JSON lines there.

Alternative layout kept in `deploy/web.config.arr` plus `install.ps1`/`deploy.ps1`: ARR reverse proxy to
pm2 on 127.0.0.1:3000 with separate web and ingest processes. Use it if the admin ever prefers
Node outside IIS.

## Farm deployment notes (Sep 2026)

Production runs on two IIS servers, IT-WebApp01 and IT-WebApp02, behind ARR. The app is built for
this: every instance serves web pages, one instance (chosen by a SQL Server application lock) runs
the MQTT ingest and scheduled jobs, and database migrations run on one instance at a time.
`https://devmon.datatelematics.io/health` shows which server answered (`host`) and which one is
the leader (`leader: true`).

Requests for the server admin:

1. **Keep the app running on both servers.** In the app pool settings on IT-WebApp01 and
   IT-WebApp02, set Idle Time-out (minutes) to 0 and Start Mode to AlwaysRunning. The IIS default
   (20 minute idle timeout) stops the app when there is no traffic, and then no server collects
   sensor data or runs alarm checks.
2. **Optional: record the deployed commit.** Add one step to the pipeline template before the
   artifact is packaged, so the site footer and `/health` show the commit instead of `unknown`:

   ```powershell
   $stamp = (Get-Date).ToUniversalTime().ToString("o")
   Set-Content -Path "$(Build.SourcesDirectory)\build.json" -Value ('{"commit":"$(Build.SourceVersion)","builtAt":"' + $stamp + '"}')
   ```

Broker (`iot.datatelematics.io`): the platform connects as MQTT user `devmon_server` on port 8883.
The broker's TLS certificate is renewed by certbot and copied into mosquitto by the deploy hook
`/etc/letsencrypt/renewal-hooks/deploy/mosquitto-certs.sh`; keep the certbot certificate named
`iot.datatelematics.io-0001`, which that hook uses.
