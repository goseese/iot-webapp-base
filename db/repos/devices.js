const { knex, T, insertId } = require("../knex");

function findById(id) { return knex(T("devices")).where({ id: id }).first(); }
function findByUid(uid) { return knex(T("devices")).where({ uid: uid }).whereNull("delete_epoch").first(); }

// Live and unarchived: the row a hardware id (MAC, host name, IMEI) currently belongs to,
// wherever it lives (architecture 3.7a). Display names are never identity.
function findLiveByHardwareId(hardwareId)
{
    return knex(T("devices")).where({ hardware_id: hardwareId, is_archived: 0 }).whereNull("delete_epoch").first();
}

function findByLocationAndName(locationId, name)
{
    return knex(T("devices")).where({ location_id: locationId, name: name }).whereNull("delete_epoch").first();
}

function findByTypeSlug(slug)
{
    return knex(T("devices") + " as d")
        .join(T("device_types") + " as dt", "dt.id", "d.device_type_id")
        .where("dt.slug", slug).whereNull("d.delete_epoch")
        .select("d.*");
}

function insert(row, trx)
{
    return (trx || knex)(T("devices")).insert(row).returning("id").then((r) => insertId(r));
}

function typeIdForSlug(slug, trx)
{
    return (trx || knex)(T("device_types")).where({ slug: slug }).first().then((r) => r ? r.id : null);
}

module.exports = { findById, findByUid, findLiveByHardwareId, findByLocationAndName, findByTypeSlug, insert, typeIdForSlug };
