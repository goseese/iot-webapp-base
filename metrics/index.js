// One module per physical quantity. Database stores canonical units only; conversion happens
// at ingest (inbound unit -> canonical) and at display (canonical -> display unit).
const fs = require("fs");
const path = require("path");

const metrics = {};
for (const file of fs.readdirSync(__dirname))
{
    if (file === "index.js" || !file.endsWith(".js")) { continue; }
    const m = require(path.join(__dirname, file));
    metrics[m.slug] = m;
}

function get(slug)
{
    const m = metrics[slug];
    if (!m) { throw new Error("unknown metric " + slug); }
    return m;
}

function toCanonical(slug, value, unit)
{
    const m = get(slug);
    if (unit === m.canonical) { return value; }
    const u = m.units[unit];
    if (!u) { throw new Error("metric " + slug + " does not accept unit " + unit); }
    return u.toCanonical(value);
}

function fromCanonical(slug, value, unit)
{
    const m = get(slug);
    if (unit === m.canonical) { return value; }
    const u = m.units[unit];
    if (!u) { throw new Error("metric " + slug + " does not accept unit " + unit); }
    return u.fromCanonical(value);
}

function precision(slug, unit)
{
    const m = get(slug);
    const u = unit === m.canonical ? m : m.units[unit];
    return (u && u.precision !== undefined) ? u.precision : m.precision;
}

module.exports = { all: metrics, get, toCanonical, fromCanonical, precision };
