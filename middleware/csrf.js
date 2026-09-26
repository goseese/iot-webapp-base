// Session bound CSRF token for every state changing form. API routes use bearer auth
// with no cookies, so they are mounted before this middleware and never see it.
const crypto = require("crypto");

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function csrf(req, res, next)
{
    if (!req.session.csrfToken)
    {
        req.session.csrfToken = crypto.randomBytes(24).toString("hex");
    }
    res.locals.csrfToken = req.session.csrfToken;

    if (SAFE.has(req.method)) { return next(); }

    const sent = (req.body && req.body._csrf) || req.get("x-csrf-token");
    if (!sent || sent.length !== req.session.csrfToken.length ||
        !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrfToken)))
    {
        const err = new Error("The form has expired. Please try again.");
        err.status = 403;
        return next(err);
    }
    next();
}

module.exports = csrf;
