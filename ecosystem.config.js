const path = require("path");

module.exports =
{
    apps:
    [
        {
            name: "web",
            script: path.join(__dirname, "app.js"),
            env: { ROLE: "web" },
            instances: 1,
            exec_mode: "fork",
            max_memory_restart: "400M"
        },
        {
            name: "ingest",
            script: path.join(__dirname, "app.js"),
            env: { ROLE: "ingest" },
            instances: 1,
            exec_mode: "fork",
            max_memory_restart: "400M"
        }
    ]
};
