// HTTPS device provisioning, first contact (dynsec-broker-summary.md).
//
// Unauthenticated on purpose: a device making first contact has no credential to present. This is
// why it cannot live under /api/v1. routes/api.js puts apiAuth on the whole router, so a device
// posting there is refused by that middleware before any handler runs. Mounted above it in app.js,
// which also keeps it ahead of session and CSRF.
//
// Flow: the device connects to the broker as the shared `announce` user, reads the retained
// con/endpoint message to learn this URL, disconnects, and POSTs { hw, model, fw } here. The model string determines the device type.
//
// Identity belongs to the unit, not to a placement (migration 0020), so every unit gets credentials
// on its first contact, placed in a location or not. A unit that already holds active credentials is
// told { existing: true, guid } and keeps them. See services/provisioning.issue().
//
// The answer waits on the broker, because the account is created before it is sent: firmware should
// allow about 20 s. Replies use real HTTP status codes:
//   200 guid + password: store them. 200 existing: keep what you have. 400: bad request, do not
//   retry. 409: another attempt is issuing, retry in a few seconds. 429: rate limited, retry after
//   the minute. 500: transient, retry with backoff.
const express = require("express");
const logger = require("../config/logger");
const settings = require("../config/settings");
const provisioning = require("../services/provisioning");
const { nowEpoch } = require("../db/knex");

const router = express.Router();

// No express.json() here. app.js parses the body before this router is reached, so a second parser
// would be a no-op and a smaller limit set here would not actually apply.

// Per IP rate limit. Modelled on the bucket in services/apiAuth.js, with one difference that
// matters: that map is keyed by credential id, a bounded set, while this one is keyed by caller IP,
// which is not. The whole map is dropped when the minute rolls over, so it can never hold more than
// one minute of distinct callers no matter who shows up.
let buckets = new Map();
let bucketMinute = 0;

function overLimit(req, res)
{
    const now = nowEpoch();
    const minute = Math.floor(now / 60);
    if (minute !== bucketMinute)
    {
        buckets = new Map();
        bucketMinute = minute;
    }
    const limit = settings.get("PROVISION_RATE_PER_MINUTE", 10);
    const ip = req.ip || "unknown";
    const count = (buckets.get(ip) || 0) + 1;
    buckets.set(ip, count);
    res.setHeader("x-ratelimit-limit", limit);
    res.setHeader("x-ratelimit-remaining", Math.max(0, limit - count));
    if (count <= limit) { return false; }
    logger.warn({ reqId: req.id, ip: ip, count: count, limit: limit }, "provision rate limit exceeded");
    res.status(429).json({ error: "Rate limit exceeded", retry_after_secs: 60 - (now % 60) });
    return true;
}

router.post("/", async (req, res, next) =>
{
    if (overLimit(req, res)) { return; }

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const hw = typeof body.hw === "string" ? body.hw.trim() : "";
    if (hw === "" || hw.length > 64)
    {
        logger.warn({ reqId: req.id, ip: req.ip }, "provision request with no usable hardware id");
        return res.status(400).json({ error: "hw is required" });
    }

    try
    {
        const result = await provisioning.issue({ hw: hw, model: body.model, fw: body.fw, correlationId: req.id });
        if (result.ok)
        {
            // existing: the unit already holds working credentials; no password is sent.
            // password is absent under a broker driver that manages no accounts (static).
            const answer = { ok: true, guid: result.guid };
            if (result.existing) { answer.existing = true; }
            if (result.password) { answer.password = result.password; }
            logger.info({ reqId: req.id, ip: req.ip, hw: hw, unit: result.guid, existing: !!result.existing }, "provision answered");
            return res.json(answer);
        }

        if (result.reason === "bad_hardware_id") { return res.status(400).json({ error: "hw must be a 12 character MAC" }); }
        if (result.reason === "missing_model") { return res.status(400).json({ error: "model is required: the device's model string, for example gw-cell-1" }); }
        if (result.reason === "unknown_model") { return res.status(400).json({ error: "model is not listed by any device type this server can provision" }); }
        if (result.reason === "in_progress")
        {
            // Another request for this unit is creating its account right now; usually a firmware
            // retry overlapping its own first attempt. Retrying in a few seconds gets the answer.
            return res.status(409).json({ error: "Provisioning already in progress for this unit; retry shortly", guid: result.guid });
        }
        logger.error({ reqId: req.id, reason: result.reason }, "provision: unhandled refusal reason");
        return res.status(500).json({ error: "Request could not be processed", reference: req.id });
    }
    catch (err) { return next(err); }
});

// Anything else under this mount answers JSON, so a device never receives an HTML page.
router.use((req, res) => res.status(404).json({ error: "Unknown endpoint" }));

// Router level error handler. middleware/errors.js renders an HTML error page for any path that
// does not start with /api/, which would send a styled 500 page to a device. Keep failures here as
// JSON, and never echo the reason: the caller is unauthenticated.
router.use((err, req, res, next) =>
{
    logger.error({ reqId: req.id, ip: req.ip, err: err.message }, "provision request failed");
    if (res.headersSent) { return next(err); }
    const status = err.status && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: "Request could not be processed", reference: req.id });
});

module.exports = router;
