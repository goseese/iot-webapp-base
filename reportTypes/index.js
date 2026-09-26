// One module per report type (architecture 9). Each exports { slug, displayName, description,
// columns, async rows(query, ctx) } where query = { locationIds, sensorIds, fromEpoch, toEpoch }.
const fs = require("fs");
const path = require("path");
const types = {};
for (const f of fs.readdirSync(__dirname)) { if (f !== "index.js" && f.endsWith(".js")) { const t = require(path.join(__dirname, f)); types[t.slug] = t; } }
function get(slug) { const t = types[slug]; if (!t) { throw new Error("unknown report type " + slug); } return t; }
module.exports = { all: types, get };
