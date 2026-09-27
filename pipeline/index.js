// Stages 2..6 for one device (architecture 7.6). Entry point for radio frames, status
// topics, the HTTP API, and the server stats job alike; downstream cannot tell them apart.
//
// input: { device (row), type (module), epoch, values: { channel: value }, gatewayId?, rssi? }
// returns { accepted: [{sensorId, channel, value, epoch}], skipped: [channel] }
const { knex, T, nowEpoch } = require("../db/knex");
const metrics = require("../metrics");
const readingsRepo = require("../db/repos/readings");
const sensorsRepo = require("../db/repos/sensors");
const alarms = require("./alarms");
const signals = require("./signals");
const publish = require("./publish");
const logger = require("../config/logger");
const deviceTypes = require("../deviceTypes");
const { addLevels } = require("./levels");

// A value for a channel the type declares but the device has no sensor for creates the sensor
// (services/devices.createSensor), so sensors exist only for what a device actually reports and a
// channel added to a type module later appears with its first value. Only live rows count: a
// deleted sensor comes back as a new sensor with the channel's next value (DECISIONS "Sensor delete
// and hide"); hiding is how a user keeps one out of sight. Only a usable value creates one.
async function createMissingSensors(input, type, byChannel, defOf)
{
    const usable = (raw) => typeof raw === "boolean" || (raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw)));
    const missing = Object.keys(input.values).filter((c) => !byChannel.has(c) && defOf(c) && usable(input.values[c]));
    if (missing.length === 0) { return; }

    const known = new Set((await knex(T("sensors")).where({ device_id: input.device.id }).whereIn("channel_id", missing).whereNull("delete_epoch").select("channel_id")).map((r) => r.channel_id));
    let created = 0;
    for (const channel of missing)
    {
        if (known.has(channel)) { continue; }
        try
        {
            await knex.transaction((trx) => require("../services/devices").createSensor(input.device, type, defOf(channel), trx));
            created++;
            logger.info({ device: input.device.uid, channel: channel }, "sensor created on first value");
        }
        catch (err)
        {
            // Another writer created it first (ux_sensors_channel); the re-read below picks it up.
            logger.warn({ err: err.message, device: input.device.uid, channel: channel }, "sensor create failed");
        }
    }
    if (created === 0 && missing.every((c) => known.has(c))) { return; }
    for (const s of await sensorsRepo.listForDevice(input.device.id))
    {
        if (!s.is_derived) { byChannel.set(s.channel_id, s); }
    }
}

async function ingest(input)
{
    const type = input.type;
    const epoch = input.epoch || nowEpoch();
    const sensors = await sensorsRepo.listForDevice(input.device.id);
    const byChannel = new Map(sensors.filter((s) => !s.is_derived).map((s) => [s.channel_id, s]));
    // Declared channels, plus per gateway ones such as rssi-72b4 (deviceTypes.channelDef).
    const defOf = (c) => deviceTypes.channelDef(type, c);
    if (!input.fromHook) { input = addLevels(input, type, byChannel, defOf); }
    await createMissingSensors(input, type, byChannel, defOf);

    // Stage 2: convert to canonical, insert, guarded hot column update.
    const rows = [];
    const accepted = [];
    const skipped = [];
    for (const [channel, raw] of Object.entries(input.values))
    {
        const sensor = byChannel.get(channel);
        const def = defOf(channel);
        if (!sensor || !def || !sensor.is_enabled) { skipped.push(channel); continue; }
        const num = typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw);
        if (!Number.isFinite(num)) { skipped.push(channel); continue; }
        const inboundUnit = input.canonical ? metrics.get(def.metric).canonical : (def.inboundUnit || metrics.get(def.metric).canonical);
        const value = metrics.toCanonical(def.metric, num, inboundUnit);
        rows.push({ sensor_id: sensor.id, epoch: epoch, value: value, gateway_id: input.gatewayId || null, rssi: input.rssi === undefined ? null : input.rssi });
        accepted.push({ sensorId: sensor.id, sensorUid: sensor.uid, channel: channel, metric: def.metric, value: value, epoch: epoch });
    }

    if (rows.length > 0)
    {
        await knex.transaction(async (trx) =>
        {
            const ids = await readingsRepo.insertMany(rows, trx);
            for (let i = 0; i < accepted.length; i++)
            {
                const id = ids[i] && ids[i].id !== undefined ? ids[i].id : ids[i];
                accepted[i].readingId = id;
                await readingsRepo.updateHot(accepted[i].sensorId, accepted[i].value, epoch, id, trx);
            }
            await trx(T("devices")).where({ id: input.device.id })
                .where(function () { this.whereNull("last_seen_epoch").orWhere("last_seen_epoch", "<", epoch); })
                .update({ last_seen_epoch: epoch, last_heard_by: input.gatewayId || input.device.last_heard_by || null });
        });
    }

    // Stage 3: type hook derived readings (e.g. heat index), inserted as ordinary readings.
    let derived = [];
    if (!input.fromHook && type.hooks && type.hooks.onDeviceInsert && accepted.length > 0)
    {
        try { derived = (await type.hooks.onDeviceInsert(input.device, accepted)) || []; }
        catch (err) { logger.error({ err: err.message, type: type.slug }, "onDeviceInsert hook failed"); }
        if (derived.length > 0)
        {
            const r = await ingest({ device: input.device, type: type, epoch: epoch, values: Object.fromEntries(derived.map((d) => [d.channel, d.value])), canonical: true, gatewayId: input.gatewayId, fromHook: true });
            accepted.push(...r.accepted);
        }
    }
    if (input.fromHook) { return { accepted: accepted, skipped: skipped }; }

    // Stage 4: signals (derived sensors) affected by what was written.
    const computed = await signals.compute(input.device, accepted, epoch);
    accepted.push(...computed);

    // Stage 5: alarms over everything written, except hidden sensors: they store readings but
    // evaluate no alarms (DECISIONS "Sensor delete and hide"). Sensors created in this pass are
    // never hidden, so the list read at the top is enough.
    const hiddenIds = new Set(sensors.filter((s) => s.is_hidden).map((s) => s.id));
    const transitions = await alarms.evaluate(input.device, accepted.filter((a) => !hiddenIds.has(a.sensorId)), epoch);

    // Stage 6: single publish point for MQTT acct/, webhooks and sockets.
    await publish.batch(input.device, accepted, transitions, epoch);

    return { accepted: accepted, skipped: skipped };
}

module.exports = { ingest };
