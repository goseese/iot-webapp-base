// Daily batched purge (architecture 13). Readings by effective retention (sensor -> account ->
// site, -1 = forever); device frames, raw publish log, activity log, expired sessions and tokens,
// old report files, unclaimed hearing rows. Never audit_log, never device_registry.
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
    if (total > 0) { logger.info({ table: label, rows: total }, "purged"); }
    return total;
}

async function readings()
{
    const now = nowEpoch();
    const siteDefault = settings.get("RETENTION_DAYS_DEFAULT", 90);
    const sensors = await knex(T("sensors") + " as s").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id").select("s.id", "s.retention_days", "l.account_id");
    const accountRetention = new Map();
    for (const r of await knex(T("account_settings")).where({ setting_key: "RETENTION_DAYS" })) { accountRetention.set(r.account_id, Number(r.setting_value)); }
    const byCutoff = new Map();
    for (const s of sensors)
    {
        const days = s.retention_days !== null ? Number(s.retention_days) : (accountRetention.has(s.account_id) ? accountRetention.get(s.account_id) : siteDefault);
        if (days === -1) { continue; }
        const cutoff = now - days * 86400;
        if (!byCutoff.has(cutoff)) { byCutoff.set(cutoff, []); }
        byCutoff.get(cutoff).push(s.id);
    }
    for (const [cutoff, ids] of byCutoff)
    {
        for (let i = 0; i < ids.length; i += 200)
        {
            const chunk = ids.slice(i, i + 200);
            await deleteBatched(() => knex(T("readings")).whereIn("sensor_id", chunk).where("epoch", "<", cutoff), "readings");
        }
    }
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
    await deleteBatched(() => knex(T("activity_log")).where("epoch", "<", now - settings.get("ACTIVITY_LOG_DAYS", 30) * 86400), "activity_log");
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
