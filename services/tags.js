// Effective tags and the one tag query object used everywhere (architecture 5.3).
const { knex, T } = require("../db/knex");

async function tagNames(entityType, entityId)
{
    const rows = await knex(T("taggings") + " as tg").join(T("tags") + " as t", "t.id", "tg.tag_id")
        .where({ "tg.entity_type": entityType, "tg.entity_id": entityId }).select("t.name");
    return rows.map((r) => r.name);
}

async function excludedNames(entityType, entityId)
{
    const rows = await knex(T("tag_exclusions") + " as tx").join(T("tags") + " as t", "t.id", "tx.tag_id")
        .where({ "tx.entity_type": entityType, "tx.entity_id": entityId }).select("t.name");
    return rows.map((r) => r.name);
}

// The inheritance rule in one place: own tags always apply; device tags apply unless the
// sensor excludes them.
function combine(own, inherited, excluded)
{
    const skip = new Set(excluded || []);
    return Array.from(new Set((own || []).concat((inherited || []).filter((t) => !skip.has(t)))));
}

// sensor = own + device's not excluded; alarms are never tagged directly, they inherit the sensor's.
async function effectiveForSensor(sensor)
{
    const own = await tagNames("sensor", sensor.id);
    const dev = await tagNames("device", sensor.device_id);
    const excluded = await excludedNames("sensor", sensor.id);
    return combine(own, dev, excluded);
}

async function effectiveForDevice(deviceId)
{
    return tagNames("device", deviceId);
}

// query: { any: [], all: [], none: [], text: "" }
function matches(query, tags, text)
{
    if (!query) { return true; }
    const set = new Set(tags || []);
    if (query.any && query.any.length > 0 && !query.any.some((t) => set.has(t))) { return false; }
    if (query.all && query.all.length > 0 && !query.all.every((t) => set.has(t))) { return false; }
    if (query.none && query.none.length > 0 && query.none.some((t) => set.has(t))) { return false; }
    if (query.text && text !== undefined && !String(text).toLowerCase().includes(String(query.text).toLowerCase())) { return false; }
    return true;
}

function parseQuery(json)
{
    if (!json) { return null; }
    try
    {
        const q = typeof json === "string" ? JSON.parse(json) : json;
        return { any: q.any || [], all: q.all || [], none: q.none || [], text: q.text || "" };
    }
    catch (err) { return null; }
}

module.exports = { tagNames, excludedNames, combine, effectiveForSensor, effectiveForDevice, matches, parseQuery };
