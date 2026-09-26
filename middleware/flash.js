// Server side flash: route sets req.session.flash = { type, msg }; this middleware moves it
// to res.locals.flash for one render; layout emits it on <body> per theme_usage.md section 4.
function flash(req, res, next)
{
    res.locals.flash = null;
    if (req.session && req.session.flash)
    {
        res.locals.flash = req.session.flash;
        delete req.session.flash;
    }
    req.flash = function (type, msg)
    {
        req.session.flash = { type: type, msg: msg };
    };
    next();
}

module.exports = flash;
