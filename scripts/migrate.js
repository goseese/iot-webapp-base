const migrate = require("../db/migrate");
const { knex } = require("../db/knex");

migrate.run({ info: (o, m) => console.log(m, o.migration) })
    .then((files) =>
    {
        console.log(files.length === 0 ? "no pending migrations" : files.length + " migration(s) applied");
        return knex.destroy();
    })
    .catch((err) =>
    {
        console.error(err);
        process.exit(1);
    });
