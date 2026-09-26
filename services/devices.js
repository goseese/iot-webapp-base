// Device creation is one transaction: the device row, its type level tags and the audit entry.
// Sensors are not created here (Sep 2026, deviates from architecture 3.2): each is created by
// createSensor when the first value for its channel arrives, with the default alarm rules and tags
// its channel declares.
const { knex, T, nowEpoch } = require("../db/knex");
const deviceTypes = require("../deviceTypes");
const devicesRepo = require("../db/repos/devices");
const sensorsRepo = require("../db/repos/sensors");
const tagsRepo = require("../db/repos/tags");
const { audit } = require("./audit");

function normalizeMac(mac)
{
    if (!mac) { return null; }
    const m = String(mac).replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (m.length !== 12) { throw new Error("MAC must be 12 hex digits"); }
    return m;
}

function isMac(value) { return /^[0-9A-F]{12}$/.test(String(value || "")); }

// Radio hardware (gateways, nodes, beacons) is identified by MAC; direct devices and assets by
// any string (host name, IMEI). input.hardwareId (input.mac still accepted for callers).
function normalizeHardwareId(type, value)
{
    if (value === undefined || value === null || String(value).trim() === "") { return null; }
    if (type.kind === "gateway" || type.kind === "node" || type.kind === "beacon") { return normalizeMac(value); }
    return String(value).trim().slice(0, 255);
}

async function create(input)
{
    const type = deviceTypes.get(input.typeSlug);
    const hardwareId = normalizeHardwareId(type, input.hardwareId !== undefined ? input.hardwareId : input.mac);
    const now = nowEpoch();

    return knex.transaction(async (trx) =>
    {
        const location = await trx(T("locations")).where({ id: input.locationId }).first();
        if (!location) { throw new Error("location not found"); }
        const typeId = await devicesRepo.typeIdForSlug(type.slug, trx);

        const deviceId = await devicesRepo.insert(
        {
            location_id: location.id,
            device_type_id: typeId,
            kind: type.kind,
            name: input.name,
            hardware_id: hardwareId,
            model: input.model || null,
            firmware: input.firmware || null,
            created_epoch: now,
            created_by: input.createdBy || null
        }, trx);
        const device = await trx(T("devices")).where({ id: deviceId }).first();

        // Direct devices are their own gateway.
        if (type.kind === "direct")
        {
            await trx(T("devices")).where({ id: deviceId }).update({ last_heard_by: deviceId });
        }

        // No credential here. Broker identity belongs to the unit, not the placement (migration
        // 0020): a unit is issued credentials on its own first contact with the provisioning
        // endpoint, before or after it is placed. If it already holds them, adding its MAC here is
        // all it takes for its data to start arriving at this row.

        // No sensors here: each is created when its first value arrives (pipeline/index.js,
        // createSensor below), so a device only ever has the sensors it actually reports.

        for (const tagName of (type.defaultTags || []))
        {
            const tagId = await tagsRepo.getOrCreate(location.account_id, tagName, false, trx);
            await tagsRepo.tag("device", deviceId, tagId, trx);
        }

        await audit(trx,
        {
            entityType: "device", entityUid: device.uid, entityName: device.name,
            field: "created", newValue: type.slug,
            actorType: input.createdBy ? "user" : "system", actorId: input.createdBy || null
        });

        return device;
    });
}

// One sensor for one declared channel, with the channel's default alarm rules and tags. Called by
// the pipeline the first time a value arrives for a channel the device has no live sensor for (a
// deleted one comes back as a new sensor, DECISIONS "Sensor delete and hide").
//
// Default alarms are declared per channel in the type module, and a channel without them gets
// none, no-data included:
//   defaultAlarms: [
//     { direction: "lower"|"upper", threshold, severity?, exceedSecs?, returnSecs? },   threshold
//     { rule: "no_data", timeoutSecs, severity? }                                       no data
//   ]
// Thresholds are canonical already (architecture 6.1). sort_order is the channel's position in
// the type's list, so sensors keep the type's order whatever order they first report in.
async function createSensor(device, type, ch, trx)
{
    const db = trx || knex;
    const now = nowEpoch();
    const location = await db(T("locations")).where({ id: device.location_id }).first();
    const sensorId = await sensorsRepo.insert(
    {
        device_id: device.id,
        channel_id: ch.id,
        name: ch.name,
        metric: ch.metric,
        is_derived: 0,
        display_unit: ch.displayUnit || null,
        display_precision: ch.displayPrecision === undefined ? null : ch.displayPrecision,
        retention_days: ch.retentionDays === undefined ? null : ch.retentionDays,
        sort_order: Math.max(type.channels.indexOf(ch.base || ch), 0),
        created_epoch: now
    }, db);

    for (const a of (ch.defaultAlarms || []))
    {
        if (a.rule === "no_data")
        {
            await db(T("alarm_rules")).insert(
            {
                sensor_id: sensorId,
                rule_kind: "no_data",
                severity: a.severity || "warning",
                timeout_secs: a.timeoutSecs,
                created_epoch: now
            });
            continue;
        }
        await db(T("alarm_rules")).insert(
        {
            sensor_id: sensorId,
            rule_kind: "threshold",
            direction: a.direction,
            threshold: a.threshold,
            severity: a.severity || "alarm",
            exceed_secs: a.exceedSecs || 0,
            return_secs: a.returnSecs || 0,
            created_epoch: now
        });
    }

    for (const tagName of (ch.defaultTags || []))
    {
        const tagId = await tagsRepo.getOrCreate(location.account_id, tagName, false, db);
        await tagsRepo.tag("sensor", sensorId, tagId, db);
    }
    return sensorId;
}

module.exports = { create, createSensor, normalizeMac, normalizeHardwareId, isMac };
