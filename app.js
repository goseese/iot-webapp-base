// Boot order: env -> db -> migrations -> settings cache -> (web: http) -> (ingest: mqtt, jobs).
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const expressLayouts = require("express-ejs-layouts");
const http = require("http");

const env = require("./config/env");
const logger = require("./config/logger");
const settings = require("./config/settings");
const migrate = require("./db/migrate");
const { knex } = require("./db/knex");
const menu = require("./nav/menu");
const pkg = require("./package.json");
const os = require("os");

// Readiness gate: HTTP listens first so pm2 and health checks see a live process; boot
// (database, migrations, seeds, settings, ingest) runs behind it. Until boot completes every
// request gets a 503 "starting"; if boot fails the process stays up and /health says why.
const state = { ready: false, error: null, startedAt: Date.now() };

// A rejected promise nobody awaited (a store warming its table check while the DB is down, a
// stray publish) must not take the process down under a launcher; log it and carry on.
process.on("unhandledRejection", (err) =>
{
    logger.error({ err: err && err.message ? err.message : String(err) }, "unhandled rejection");
});

async function boot()
{
    await require("./db/createDb").ensureDatabase(logger);   // no-op when it exists or the login cannot create it
    await knex.raw("SELECT 1");
    logger.info({ host: env.db.host, db: env.db.name }, "database reachable");

    if (env.role === "web")
    {
        // A pure web process never migrates or seeds.
        const pending = await migrate.pending();
        if (pending.length > 0)
        {
            throw new Error("pending migrations: " + pending.join(", ") + " (run npm run migrate)");
        }
    }
    else
    {
        // Only the single ingest process migrates and seeds, behind the 503 "starting" page.
        const pending = await migrate.pending();
        if (pending.length > 0)
        {
            if (!env.autoMigrate)
            {
                throw new Error("pending migrations: " + pending.join(", ") + " (run npm run migrate)");
            }
            await migrate.run(logger);
        }
        await require("./seeds").run(logger);     // idempotent; shadows device types, first boot creates superadmin + System account
    }
    // Stamp the MQTT settings before loading them, so a change made in between is still picked up.
    await require("./mqtt/watch").start();
    await settings.reload();

    if (env.role === "web" || env.role === "all")
    {
        // The relay reads broker settings, so it connects only once the cache is loaded.
        require("./realtime").connectFeed();
    }

    if (env.role === "ingest" || env.role === "all")
    {
        // One ingest process on this server; it runs ingest and jobs.
        require("./services/leader").start(startIngest);
    }
    state.ready = true;
    logger.info({ ms: Date.now() - state.startedAt }, "boot complete");
}

async function startWeb()
{
    const app = express();
    const server = http.createServer(app);

    // nginx on this server terminates TLS and proxies over loopback. Trust only that hop, so
    // req.ip and req.secure come from its X-Forwarded-For and X-Forwarded-Proto. Without this the
    // Secure session cookie is never set in production and every login loops.
    app.set("trust proxy", env.isProd ? "loopback" : false);
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));
    app.set("layout", "layouts/app");
    app.use(expressLayouts);
    // The support modal on every signed in page (views/partials/support-modal.ejs): severities and limits.
    app.locals.supportForm = { severities: require("./services/support").SEVERITIES, defaultSeverity: require("./services/support").DEFAULT_SEVERITY, maxDescription: require("./services/support").MAX_DESCRIPTION, maxMb: require("./services/support").MAX_BYTES / 1048576 };

    app.use(helmet({ contentSecurityPolicy: false }));   // inline page scripts and echarts; CSP tightened later
    app.use(express.static(path.join(__dirname, "public"), { maxAge: env.isProd ? "7d" : 0 }));
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json({ limit: "2mb" }));

    const { requestId, notFound, errorHandler } = require("./middleware/errors");
    app.use(requestId);
    app.get("/health", (req, res) =>
    {
        const build = require("./config/build");
        if (state.ready)
        {
            return res.json(
            {
                ok: true,
                role: env.role,
                version: build.version,
                commit: build.shortCommit,
                booted_at: build.bootedAt.toISOString(),
                host: os.hostname(),
                pid: process.pid,
                leader: require("./services/leader").isLeader()
            });
        }
        res.status(503).json(
        {
            ok: false,
            state: state.error ? "boot failed" : "starting",
            error: state.error ? (env.isProd ? state.error.split("\n")[0] : state.error) : null,
            uptime_ms: Date.now() - state.startedAt
        });
    });
    app.use((req, res, next) =>
    {
        if (state.ready) { return next(); }
        res.set("retry-after", "5");
        res.status(503).type("html").send("<!doctype html><meta charset='utf-8'><title>Starting</title><p style='font-family:system-ui;margin:2rem'>" + (state.error ? "The site could not start. See /health for the reason." : "The site is starting; try again in a few seconds.") + "</p>");
    });

    // Event log request rows (middleware/eventLog.js): device and API requests here, ahead of their
    // routers; everything else right after the session, so the start row knows the user.
    const eventLog = require("./middleware/eventLog");
    app.use(eventLog.early());
    app.use("/provision/v1", require("./routes/provision")); // unauthenticated device first contact; must precede /api/v1
    app.use("/firmware", require("./routes/firmware"));       // unauthenticated device firmware downloads (services/firmware.js)
    app.use("/api/v1", require("./routes/api"));            // bearer only, before session and CSRF

    const sessionMiddleware = require("./middleware/session").build();
    app.use(sessionMiddleware);
    app.use(eventLog.web());
    app.use(require("./middleware/flash"));
    app.use(require("./middleware/csrf"));
    const auth = require("./middleware/auth");
    app.use(auth.loadUser);
    app.use(auth.mustSetPassword);
    app.use(require("./middleware/account").currentAccount);
    // Support badges, computed per page from the database (no polling): the superadmin's Support
    // requests count, and the accounts this user is support for with their waiting counts (the
    // Account > Support menu item). GET pages only; posts redirect.
    app.use(async (req, res, next) =>
    {
        res.locals.supportOpenCount = 0;
        req.supportAccounts = null;
        if (req.user && req.method === "GET")
        {
            const support = require("./services/support");
            try
            {
                if (req.user.is_superadmin) { res.locals.supportOpenCount = await support.openCount(); }
                req.supportAccounts = await support.openByAccount(req.user);
            }
            catch (err) { /* the badges are not worth failing a page for */ }
        }
        next();
    });
    app.use((req, res, next) =>
    {
        // Resolved at render time, after the route has said which location (if any) the page is in.
        // req.path is router-relative by render time, so resolve against the full URL path.
        Object.defineProperty(res.locals, "nav", { enumerable: true, configurable: true, get: () => menu.resolve(req.originalUrl.split("?")[0], req.user, req.navLocation || null, req.account || null, req.supportAccounts || null) });
        Object.defineProperty(res.locals, "currentLocation", { enumerable: true, configurable: true, get: () => req.navLocation || null });
        res.locals.buildTrail = (navTrail) => require("./nav/breadcrumb").build(res.locals.nav, navTrail, req.account || null, req.navLocation || null);
        res.locals.appVersion = pkg.version;
        res.locals.build = require("./config/build");
        // Cache buster for our own css/js: changes with every build (commit, else boot time).
        res.locals.assetV = res.locals.build.shortCommit !== "unknown" ? res.locals.build.shortCommit : String(res.locals.build.bootedAt.getTime());
        res.locals.title = res.locals.title || "";
        res.locals.fmt = require("./services/format");
        res.locals.now = Math.floor(Date.now() / 1000);
        settings.ensureFresh().then(() => next()).catch(next);
    });

    app.use(require("./routes"));

    app.use(notFound);
    app.use(errorHandler);

    require("./realtime").start(server, sessionMiddleware);
    await new Promise((resolve, reject) =>
    {
        server.once("error", reject);
        server.listen(env.port, env.host, resolve);
    });
    logger.info({ host: env.host, port: env.port, url: env.appUrl }, "web listening");
    return server;
}

function startIngest()
{
    require("./mqtt/client").connect();
    require("./jobs").start();
}

async function main()
{
    if (env.role === "web" || env.role === "all")
    {
        await startWeb();
    }
    try
    {
        await boot();
    }
    catch (err)
    {
        state.error = err.message;
        logger.fatal({ err: err }, "boot failed");
        if (env.role === "ingest") { process.exit(1); }          // nothing to serve; let the supervisor restart it
        // web/all: stay up so /health and the 503 page report the failure instead of a launcher timeout
    }
}

main().catch((err) =>
{
    logger.fatal({ err: err }, "fatal");
    process.exit(1);
});
