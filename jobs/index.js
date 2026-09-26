// Minute and daily schedulers. Tasks register here; each run is guarded so a slow task never
// overlaps itself. Runs only in the ingest process.
const logger = require("../config/logger");

const minuteTasks = [];
const dailyTasks = [];
const running = new Set();

function register(list, name, fn) { list.push({ name: name, fn: fn }); }

async function runAll(list)
{
    for (const t of list)
    {
        if (running.has(t.name)) { logger.warn({ task: t.name }, "task still running, skipped"); continue; }
        running.add(t.name);
        const started = Date.now();
        try { await t.fn(); }
        catch (err) { logger.error({ task: t.name, err: err.message, stack: err.stack }, "task failed"); }
        finally { running.delete(t.name); }
        logger.debug({ task: t.name, ms: Date.now() - started }, "task done");
    }
}

function start()
{
    require("./minute").register((name, fn) => register(minuteTasks, name, fn));
    require("./daily").register((name, fn) => register(dailyTasks, name, fn));

    const msToNextMinute = 60000 - (Date.now() % 60000);
    setTimeout(() =>
    {
        runAll(minuteTasks);
        setInterval(() => runAll(minuteTasks), 60000);
    }, msToNextMinute);

    // Daily at 03:10 server local time; checked each minute.
    setInterval(() =>
    {
        const d = new Date();
        if (d.getHours() === 3 && d.getMinutes() === 10) { runAll(dailyTasks); }
    }, 60000);
    logger.info({ minute: minuteTasks.length, daily: dailyTasks.length }, "jobs scheduled");
}

module.exports = { start };
