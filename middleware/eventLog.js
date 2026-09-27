// Request rows for the event log (DECISIONS.md "Event log", reference design in the event log
// README). A "request" row when a request starts (method, path, query, redacted body, ip, user
// agent) and a "request_end" row when its response finishes (status, duration), both carrying
// req.id as the correlation id, so every event a handler records during the request groups under
// it. Writes are never awaited: a slow database never delays a page.
//
// Mounted twice in app.js:
//   early()  before /provision/v1, /firmware and /api/v1, which run ahead of the session; it handles only
//            those paths (channel device or api). Their actor is known at the end (the API key).
//   web()    right after the session, before CSRF, for everything else, so the start row already
//            has the signed in user and CSRF refusals are logged too. A login shows the user on
//            its end row only, a logout on its start row only.
const events = require("../db/repos/events");
const logger = require("../config/logger");

// Never logged: the log viewer itself, the health probe, and pollers that fire on every open page
// (the sidebar alarm badge every 30 s, the config page's rows refresh).
const SKIP = [/^\/admin\/logs(\/|$)/, /^\/health$/, /^\/alarms\/count\.json$/, /^\/devices\/[^/]+\/config\/rows$/];
// Assets are served by express.static before this; the ones that fall through are 404s.
const STATIC_RE = /\.(js|css|map|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)$/i;
// Field names whose values are never stored, at any depth. `current` is the current password on
// the change password form.
const SECRET_FIELD_RE = /pass|secret|token|csrf|^current$/i;
// Forms that post a possibly secret value under a plain name: a site setting (the key is in the
// path, and secret settings are among them) and a device config write (WiFi passwords).
const VALUE_IS_SECRET = [/^\/admin\/settings\/[^/]+$/, /^\/devices\/[^/]+\/config$/];
// One time links: the token in the path is replaced, never stored.
const TOKEN_PATHS = [/^(\/reset\/)[^/]+/, /^(\/invite\/)[^/]+/, /^(\/a\/)[^/]+/];
// Details larger than this lose the body, then the query, so one huge API post cannot bloat the table.
const MAX_DETAILS = 8192;

function redact(value, depth)
{
    if (depth > 5 || value === null || typeof value !== "object") { return value; }
    if (Array.isArray(value)) { return value.map((v) => redact(v, depth + 1)); }
    const out = {};
    for (const k of Object.keys(value))
    {
        out[k] = SECRET_FIELD_RE.test(k) ? "[redacted]" : redact(value[k], depth + 1);
    }
    return out;
}

function cleanPath(p)
{
    for (const re of TOKEN_PATHS)
    {
        if (re.test(p)) { return p.replace(re, "$1[token]"); }
    }
    return p;
}

function channelOf(req)
{
    if (req.xhr) { return "ajax"; }
    if ((req.get("accept") || "").includes("application/json")) { return "ajax"; }
    // Browsers send Sec-Fetch-Dest: document for a page load and empty for fetch() and XHR, which
    // is the only way to tell a plain fetch() (no X-Requested-With, Accept */*) from a page.
    const dest = req.get("sec-fetch-dest");
    if (dest && dest !== "document" && dest !== "iframe") { return "ajax"; }
    return "web";
}

function startDetails(req)
{
    const path = cleanPath(req.path);
    const details = { method: req.method, path: path };
    if (req.query && Object.keys(req.query).length > 0) { details.query = redact(req.query, 0); }
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0)
    {
        let body = redact(req.body, 0);
        if (req.method !== "GET" && VALUE_IS_SECRET.some((re) => re.test(req.path)) && body.value !== undefined)
        {
            body = Object.assign({}, body, { value: "[redacted]" });
        }
        details.body = body;
    }
    details.ip = req.ip || null;
    const ua = req.get("user-agent");
    if (ua) { details.user_agent = ua.slice(0, 300); }

    let size = JSON.stringify(details).length;
    if (size > MAX_DETAILS && details.body !== undefined)
    {
        details.body = { truncated: true, bytes: JSON.stringify(details.body).length };
        size = JSON.stringify(details).length;
    }
    if (size > MAX_DETAILS && details.query !== undefined)
    {
        details.query = { truncated: true, bytes: JSON.stringify(details.query).length };
    }
    return details;
}

function write(row)
{
    events.insert(row).catch((err) => { logger.warn({ err: err.message, event: row.event, reqId: row.correlation_id }, "event log write failed"); });
}

function sessionUserId(req)
{
    return req.session && req.session.userId ? req.session.userId : null;
}

function begin(req, res, channel)
{
    req.eventChannel = channel;
    const started = Date.now();
    write(
    {
        time: started,
        user_id: sessionUserId(req),
        channel: channel,
        event: "request",
        correlation_id: req.id,
        details: startDetails(req)
    });

    // Web requests take the user from the session as it stands after the request, so a login shows
    // the user on its end row and a logout does not. API and device requests have no session.
    const bySession = channel !== "api" && channel !== "device";
    let done = false;
    function end(aborted)
    {
        if (done) { return; }
        done = true;
        const details = { status: res.statusCode, duration_ms: Date.now() - started };
        if (aborted) { details.aborted = true; }
        write(
        {
            user_id: bySession ? sessionUserId(req) : null,
            api_credential_id: req.apiCredential ? req.apiCredential.id : null,
            account_id: req.account && req.account.id ? req.account.id : null,
            channel: channel,
            event: "request_end",
            correlation_id: req.id,
            details: details
        });
    }
    res.once("finish", () => end(false));
    // A client that goes away before the response is sent still gets an end row, marked aborted.
    res.once("close", () => end(!res.writableFinished));
}

function skipped(req)
{
    return req.eventChannel !== undefined || STATIC_RE.test(req.path) || SKIP.some((re) => re.test(req.path));
}

function early()
{
    return (req, res, next) =>
    {
        if (!skipped(req))
        {
            if (req.path.startsWith("/api/")) { begin(req, res, "api"); }
            else if (req.path.startsWith("/provision/") || req.path.startsWith("/firmware/")) { begin(req, res, "device"); }
        }
        next();
    };
}

function web()
{
    return (req, res, next) =>
    {
        if (!skipped(req)) { begin(req, res, channelOf(req)); }
        next();
    };
}

module.exports = { early, web, redact, cleanPath, channelOf };
