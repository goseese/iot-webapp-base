const activity = require("../db/repos/activity");
const settings = require("../config/settings");
const { nowEpoch } = require("../db/knex");

function actorOf(req)
{
    if (req.user) { return { actor_type: "user", actor_id: req.user.id, actor_name: req.user.username }; }
    if (req.apiCredential) { return { actor_type: "api_credential", actor_id: req.apiCredential.id, actor_name: req.apiCredential.name }; }
    return { actor_type: "anonymous", actor_id: null, actor_name: null };
}

function log(req, action, fields)
{
    const row = Object.assign(actorOf(req),
    {
        action: action,
        ip: req.ip || null,
        user_agent: (req.get("user-agent") || "").slice(0, 300) || null,
        outcome: "ok"
    }, fields || {});
    return activity.insert(row).catch(() => {});   // logging must never break a request
}

async function loginLocked(loginName, ip)
{
    const max = settings.get("LOGIN_MAX_FAILURES", 10);
    const since = nowEpoch() - settings.get("LOGIN_WINDOW_MINUTES", 15) * 60;
    const byName = await activity.countRecent("login_failed", "actor_name", loginName, since);
    if (byName >= max) { return true; }
    const byIp = await activity.countRecent("login_failed", "ip", ip, since);
    return byIp >= max;
}

module.exports = { log, loginLocked, actorOf };
