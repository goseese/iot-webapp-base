const { knex, T, nowEpoch } = require("../db/knex");
const accountsRepo = require("../db/repos/accounts");
const tagsRepo = require("../db/repos/tags");
const alertGroups = require("./alertGroups");
const { audit } = require("./audit");

const KNOWN_TAGS = ["dashboard", "dailyReport"];

async function create(name, actor)
{
    return knex.transaction(async (trx) =>
    {
        const id = await accountsRepo.insert({ name: name, created_epoch: nowEpoch(), created_by: actor ? actor.id : null }, trx);
        for (const t of KNOWN_TAGS) { await tagsRepo.getOrCreate(id, t, true, trx); }
        await alertGroups.ensureDefault(id, trx);
        const account = await trx(T("accounts")).where({ id: id }).first();
        await audit(trx, { entityType: "account", entityUid: account.uid, entityName: name, field: "created", actorType: actor ? "user" : "system", actorId: actor ? actor.id : null, actorName: actor ? actor.username : null });
        return account;
    });
}

async function update(account, patch, actor)
{
    await knex.transaction(async (trx) =>
    {
        for (const [field, value] of Object.entries(patch))
        {
            if (String(account[field]) !== String(value))
            {
                await audit(trx, { entityType: "account", entityUid: account.uid, entityName: account.name, field: field, oldValue: account[field], newValue: value, actorType: "user", actorId: actor.id, actorName: actor.username });
            }
        }
        await trx(T("accounts")).where({ id: account.id }).update(patch);
    });
}

module.exports = { create, update };
