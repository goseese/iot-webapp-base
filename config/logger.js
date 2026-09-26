const pino = require("pino");
const env = require("./env");

const logger = pino(
{
    level: env.isProd ? "info" : "debug",
    base: { role: env.role }
});

module.exports = logger;
