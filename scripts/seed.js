// Seeds are idempotent: each one checks before it writes. Step 3 fills seeds/.
const { knex } = require("../db/knex");
const seeds = require("../seeds");

seeds.run({ info: (o, m) => console.log(m, o) })
    .then(() => knex.destroy())
    .catch((err) =>
    {
        console.error(err);
        process.exit(1);
    });
