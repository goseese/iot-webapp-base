const { knex, T } = require("../db/knex");
const alertGroups = require("../services/alertGroups");

async function run(log)
{
    for (const a of await knex(T("accounts")).whereNull("delete_epoch"))
    {
        await alertGroups.ensureDefault(a.id);
    }
}

module.exports = { run };
