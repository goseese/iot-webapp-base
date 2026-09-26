const session = require("express-session");
const { ConnectSessionKnexStore } = require("connect-session-knex");
const env = require("../config/env");
const settings = require("../config/settings");
const { knex, T } = require("../db/knex");

function build()
{
    const store = new ConnectSessionKnexStore(
    {
        knex: knex,
        tableName: T("sessions"),
        createTable: false,          // owned by migration 0001
        cleanupInterval: 15 * 60 * 1000
    });

    const hours = settings.get("SESSION_HOURS", 168);

    return session(
    {
        name: "devmon.sid",
        secret: env.sessionSecret,
        store: store,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        proxy: env.isProd,           // IIS ARR terminates TLS; trust X-Forwarded-Proto
        cookie:
        {
            httpOnly: true,
            sameSite: "lax",
            secure: env.isProd,
            maxAge: hours * 60 * 60 * 1000
        }
    });
}

module.exports = { build };
