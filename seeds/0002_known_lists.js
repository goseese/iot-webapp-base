// Known lists seeded from code at site scope (architecture 5.2). Items are added if missing,
// never removed or reordered, so admin edits survive.
const { knex, T, insertId } = require("../db/knex");

const LISTS =
[
    {
        slug: "ack_reasons", name: "Acknowledgement reasons", items:
        [
            "Investigating", "Known issue, fix in progress", "Door open, recovering", "Scheduled maintenance", "False alarm"
        ]
    },
    {
        slug: "offline_reasons", name: "Offline reasons", items:
        [
            "Maintenance", "Decommissioned", "Awaiting repair", "Seasonal shutdown", "Relocating"
        ]
    }
];

async function run(log)
{
    for (const l of LISTS)
    {
        let list = await knex(T("lists")).where({ slug: l.slug, scope_type: "site" }).whereNull("scope_id").first();
        if (!list)
        {
            const r = await knex(T("lists")).insert({ slug: l.slug, scope_type: "site", scope_id: null, display_name: l.name, order_mode: "entered" }).returning("id");
            list = { id: insertId(r) };
            if (log) { log.info({ slug: l.slug }, "seeded list"); }
        }
        let sort = 0;
        for (const label of l.items)
        {
            const value = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            const existing = await knex(T("list_items")).where({ list_id: list.id, value: value }).first();
            if (!existing)
            {
                await knex(T("list_items")).insert({ list_id: list.id, label: label, value: value, sort_order: sort });
            }
            sort++;
        }
    }
}

module.exports = { run };
