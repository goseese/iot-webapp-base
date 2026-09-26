function register(add)
{
    add("purge", require("./tasks/purge").run);
    add("conEndpoint", require("./tasks/connectEndpoint").run);
    add("brokerAudit", require("./tasks/brokerAudit").run);
    add("unitCleanup", require("./tasks/unitCleanup").run);
}

module.exports = { register };
