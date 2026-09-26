// First superadmin from SEED_SUPERADMIN_* in .env. Password is random, printed once, and the
// account is confined to setting a new one on first login (must_set_password).
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const env = require("../config/env");
const { knex, T, nowEpoch } = require("../db/knex");

async function run(log)
{
    if (!env.seed.superadminUsername || !env.seed.superadminEmail)
    {
        if (log) { log.info({}, "SEED_SUPERADMIN_USERNAME/EMAIL not set, skipping superadmin"); }
        return;
    }
    const existing = await knex(T("users")).where({ email: env.seed.superadminEmail }).whereNull("delete_epoch").first();
    if (existing) { return; }

    const fixed = env.seed.superadminPassword;
    const password = fixed || crypto.randomBytes(12).toString("base64url");
    await knex(T("users")).insert(
    {
        username: env.seed.superadminUsername,
        email: env.seed.superadminEmail,
        password_hash: await bcrypt.hash(password, 12),
        is_superadmin: 1,
        must_set_password: 1,
        password_changed_epoch: nowEpoch(),
        created_epoch: nowEpoch()
    });
    console.log("");
    console.log("==========================================================");
    console.log("  Superadmin created: " + env.seed.superadminUsername + " <" + env.seed.superadminEmail + ">");
    console.log("  One time password:  " + (fixed ? "(from SEED_SUPERADMIN_PASSWORD)" : password));
    console.log("  You will be asked to set a new password at first login.");
    console.log("==========================================================");
    console.log("");
    if (log) { log.info({ username: env.seed.superadminUsername, fixedPassword: !!fixed }, "superadmin created"); }
}

module.exports = { run };
