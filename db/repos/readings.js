const { knex, T, isUniqueViolation } = require("../knex");

function insertMany(rows, trx)
{
    if (rows.length === 0) { return Promise.resolve([]); }
    return (trx || knex)(T("readings")).insert(rows).returning("id");
}

// Hot column guard: a late buffered frame never overwrites newer state (schema-conventions 5).
function updateHot(sensorId, value, epoch, readingId, trx)
{
    return (trx || knex)(T("sensors"))
        .where({ id: sensorId })
        .where(function () { this.whereNull("last_epoch").orWhere("last_epoch", "<", epoch); })
        .update({ last_value: value, last_epoch: epoch, last_reading_id: readingId });
}

// Dedup claim: the unique index arbitrates; a unique violation = another gateway already won (schema-conventions 4).
async function claimFrame(deviceId, counter, epoch)
{
    try
    {
        await knex(T("device_frames")).insert({ device_id: deviceId, frame_counter: counter, epoch: epoch });
        return true;
    }
    catch (err)
    {
        if (isUniqueViolation(err)) { return false; }
        throw err;
    }
}

async function upsertCoverage(deviceId, gatewayId, epoch, rssi)
{
    const updated = await knex(T("device_coverage")).where({ device_id: deviceId, gateway_id: gatewayId })
        .update({ last_heard_epoch: epoch, last_rssi: rssi === undefined ? null : rssi });
    if (updated === 0)
    {
        try { await knex(T("device_coverage")).insert({ device_id: deviceId, gateway_id: gatewayId, last_heard_epoch: epoch, last_rssi: rssi === undefined ? null : rssi }); }
        catch (err) { if (!isUniqueViolation(err)) { throw err; } }
    }
}

module.exports = { insertMany, updateHot, claimFrame, upsertCoverage };
