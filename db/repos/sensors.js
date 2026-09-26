const { knex, T, insertId } = require("../knex");

function findByUid(uid) { return knex(T("sensors")).where({ uid: uid }).whereNull("delete_epoch").first(); }

function listForDevice(deviceId, trx)
{
    return (trx || knex)(T("sensors")).where({ device_id: deviceId }).whereNull("delete_epoch").orderBy("sort_order");
}

function insert(row, trx)
{
    return (trx || knex)(T("sensors")).insert(row).returning("id").then((r) => insertId(r));
}

module.exports = { findByUid, listForDevice, insert };
