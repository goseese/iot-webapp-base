// Daily refresh of the retained con/endpoint message.
//
// Not about keeping the message alive: the broker has persistence on, so it survives restarts on
// its own. This is so the "published" date in the payload means something. Refreshed once a day, a
// date older than that says no leader has been running, which is worth knowing before a shop unit
// fails to provision.
const endpoint = require("../../services/connectEndpoint");

async function run()
{
    endpoint.publish();
}

module.exports = { run };
