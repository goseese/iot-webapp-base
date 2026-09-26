// Every reply leaves this app with status 200.
//
// Why: the WebApp servers run IIS with <httpErrors> at its default existingResponse="Auto", and
// PassThrough is not permitted. IIS then replaces the body of any 4xx or 5xx reply with its own
// generic error text, so our login error, our form validation messages and our JSON error bodies
// never reach the caller. A 2xx reply is never intercepted, so the body survives.
//
// The real code is not lost. It goes out in the x-app-status header, and for JSON replies as
// "status" in the body next to ok:false.
//
// To revert, for example if PassThrough is ever allowed, set ENABLED to false. Nothing else
// changes and every route goes back to its real status code.
const logger = require("../config/logger");

const ENABLED = true;

// Paths that keep their real status because a machine reads the code and nothing reads the body.
// /health: deploy/deploy.ps1 aborts the deploy on a non-2xx, and the cluster probe uses it to pull
// a failed server out of rotation. A /health that always says 200 hides a failed boot.
const EXEMPT = ["/health"];

// Single place every refused reply passes through. Widen this when you want reply logging.
function onReply(req, code)
{
    logger.debug({ reqId: req.id, method: req.method, url: req.originalUrl, appStatus: code }, "reply sent as 200");
}

function build()
{
    return function httpStatus(req, res, next)
    {
        if (!ENABLED || EXEMPT.includes(req.path)) { return next(); }

        const status = res.status.bind(res);
        const json = res.json.bind(res);

        res.status = function (code)
        {
            if (code >= 400)
            {
                res.locals.appStatus = code;
                res.setHeader("x-app-status", code);
                onReply(req, code);
                return status(200);
            }
            return status(code);
        };

        res.json = function (body)
        {
            const code = res.locals.appStatus;
            if (code && body && typeof body === "object" && !Array.isArray(body))
            {
                // Defaults only. A body that already sets ok or status keeps its own values.
                return json(Object.assign({ ok: false, status: code }, body));
            }
            return json(body);
        };

        next();
    };
}

module.exports = { build, ENABLED, EXEMPT };
