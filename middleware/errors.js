const crypto = require("crypto");
const logger = require("../config/logger");

function requestId(req, res, next)
{
    req.id = crypto.randomBytes(6).toString("hex");
    res.setHeader("x-request-id", req.id);
    next();
}

// A denied or missing resource is a plain 404, never a hint that it exists (architecture 4.3).
function notFoundError()
{
    const err = new Error("Not found");
    err.status = 404;
    return err;
}

function notFound(req, res, next)
{
    next(notFoundError());
}

// Users see a reference id, never a stack. API paths get JSON, everything else a page.
function errorHandler(err, req, res, next)
{
    const status = err.status || 500;
    if (status >= 500)
    {
        logger.error({ reqId: req.id, url: req.originalUrl, err: err }, "unhandled error");
    }
    if (res.headersSent) { return next(err); }

    if (req.path.startsWith("/api/"))
    {
        return res.status(status).json({ error: status === 500 ? "Internal error" : err.message, reference: req.id });
    }

    const view = status === 404 ? "errors/404" : "errors/500";
    const layout = res.locals.currentUser ? "layouts/app" : "layouts/auth";
    res.status(status).render(view,
    {
        layout: layout,
        title: status === 404 ? "Not found" : "Something went wrong",
        message: status === 500 ? null : err.message,
        reference: req.id,
        nav: null
    });
}

module.exports = { requestId, notFound, notFoundError, errorHandler };
