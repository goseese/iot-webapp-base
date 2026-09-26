// Creates the database named in .env if it does not exist (boot does this too; kept for
// running ahead of a deploy or with a more privileged login).
const { ensureDatabase } = require("../db/createDb");
const env = require("../config/env");

ensureDatabase({ info: (o, m) => console.log(m, o.db), warn: (o, m) => console.warn(m, o.err) })
    .then((r) =>
    {
        if (r.error) { console.error("database " + env.db.name + ": " + r.error); process.exit(1); }
        console.log("database " + env.db.name + (r.created ? " created" : " ready"));
    })
    .catch((err) => { console.error(err.message); process.exit(1); });
