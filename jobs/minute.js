function register(add)
{
    add("server_stats", require("./tasks/serverStats").run);
    add("no_data", require("../services/alarms/nodata").run);
    add("escalation", require("../services/alarms/escalation").run);
    add("offline_periods", require("./tasks/offlinePeriods").run);
    add("webhooks", require("../services/webhooks").deliverPending);
    add("scheduled_reports", require("../services/reports").runDue);
}

module.exports = { register };
