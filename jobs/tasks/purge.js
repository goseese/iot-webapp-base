// Daily batched purge (architecture 13). Readings by effective retention (sensor -> account ->
// site, -1 = forever); device frames, raw publish log, event log, finished queued commands,
// expired sessions and tokens, old report files, unclaimed hearing rows. Never audit_log, never
// device_registry.
const fs = require("fs");
const path = require("path");
const settings = require("../../config/settings");
const logger = require("../../config/logger");
const { knex, T, nowEpoch } = require("../../db/knex");

async function deleteBatched(builderFn, label)
{
    const batch = settings.get("PURGE_BATCH_ROWS", 2000);
    let total = 0;
    for (let i = 0; i < 500; i++)
    {
        const ids = await builderFn().limit(batch).pluck("id");
        if (ids.length === 0) { break; }
        total += await builderFn().whereIn("id", ids).del();
        if (ids.length < batch) { break; }
    }
    if (total > 0 && label) { logger.info({ table: label, rows: total }, "purged"); }
    return total;
}

// Start of the oldest of the newest `keep` UTC days that hold a reading, or null when the sensor
// has fewer than `keep` such days. Steps back one day per probe on ix_readings_sensor_epoch, so
// days without readings are never counted (about `keep` index lookups per sensor).
async function dataDaysCutoff(sensorId, keep)
{
    const sql = `WITH RECURSIVE d (day, n) AS
    (
        SELECT (SELECT max(epoch) FROM ${T("readings")} WHERE sensor_id = ?) / 86400, 1
        UNION ALL
        SELECT (SELECT max(r.epoch) FROM ${T("readings")} r WHERE r.sensor_id = ? AND r.epoch < d.day * 86400) / 86400, d.n + 1
        FROM d
        WHERE d.n < ? AND d.day IS NOT NULL
    )
    SELECT day * 86400 AS cutoff FROM d WHERE n = ? AND day IS NOT NULL`;
    const res = await knex.raw(sql, [sensorId, sensorId, keep, keep]);
    return res.rows.length ? Number(res.rows[0].cutoff) : null;
}

async function readings()
{
    const now = nowEpoch();
    const siteDefault = settings.get("RETENTION_DAYS_DEFAULT", 90);
    const sensors = await knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id").select("s.id", "s.retention_days", "l.account_id");
    const accountRetention = new Map();
    for (const r of await knex(T("account_settings")).where({ setting_key: "RETENTION_DAYS" })) { accountRetention.set(r.account_id, Number(r.setting_value)); }
    let total = 0;
    for (const s of sensors)
    {
        const days = s.retention_days !== null ? Number(s.retention_days) : (accountRetention.has(s.account_id) ? accountRetention.get(s.account_id) : siteDefault);
        if (days === -1) { continue; }
        // Keep the newest days + 1 UTC days that hold data; silent days do not count.
        const cutoff = await dataDaysCutoff(s.id, Number(days) + 1);
        if (cutoff === null) { continue; }
        total += await deleteBatched(() => knex(T("readings")).where("sensor_id", s.id).where("epoch", "<", cutoff), null);
    }
    if (total > 0) { logger.info({ table: "readings", rows: total }, "purged"); }
    // Readings of deleted sensors go once their device's retention window has passed the delete.
    const gone = await knex(T("sensors")).whereNotNull("delete_epoch").where("delete_epoch", "<", now - siteDefault * 86400).pluck("id");
    for (let i = 0; i < gone.length; i += 200) { const chunk = gone.slice(i, i + 200); await deleteBatched(() => knex(T("readings")).whereIn("sensor_id", chunk), "readings(deleted sensors)"); }
}

async function run()
{
    const now = nowEpoch();
    await readings();
    await deleteBatched(() => knex(T("device_frames")).where("epoch", "<", now - settings.get("DEVICE_FRAMES_HOURS", 24) * 3600), "device_frames");
    await deleteBatched(() => knex(T("raw_publish_log")).where("epoch", "<", now - Math.max(1, settings.get("RAW_PUBLISH_LOG_DAYS", 0)) * 86400), "raw_publish_log");
    await deleteBatched(() => knex(T("event_log")).where("time", "<", (now - settings.get("EVENT_LOG_DAYS", 30) * 86400) * 1000), "event_log");
    // Finished queued commands (services/commandQueue.js); queued and sent ones stay until acked or cancelled.
    await deleteBatched(() => knex(T("command_queue")).whereNotNull("done_epoch").where("done_epoch", "<", now - 30 * 86400), "command_queue");
    // Where unclaimed devices were heard (DECISIONS "Unclaimed devices, per account"): a MAC no
    // gateway has heard for 30 days drops off the Unclaimed devices pages.
    await deleteBatched(() => knex(T("unclaimed_heard")).where("last_heard_epoch", "<", now - settings.get("UNCLAIMED_HEARD_DAYS", 30) * 86400), "unclaimed_heard");
    await deleteBatched(() => knex(T("tokens")).where("expires_epoch", "<", now - 86400), "tokens");
    await deleteBatched(() => knex(T("notifications")).where("epoch", "<", now - 365 * 86400), "notifications");
    await deleteBatched(() => knex(T("webhook_deliveries")).where("epoch", "<", now - 30 * 86400), "webhook_deliveries");
    await knex(T("sessions")).where("expired", "<", new Date()).del();

    const keep = settings.get("REPORT_FILE_DAYS", 30) * 86400;
    const runs = await knex(T("report_runs")).whereNotNull("file_path").where("epoch", "<", now - keep);
    const dir = require("../../services/reports").DIR;
    for (const r of runs)
    {
        try { fs.unlinkSync(path.join(dir, path.basename(r.file_path))); } catch (err) {}
        await knex(T("report_runs")).where({ id: r.id }).update({ file_path: null });
    }
}

module.exports = { run };
