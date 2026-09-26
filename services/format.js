// View helpers exposed as res.locals.fmt. Epochs are UTC seconds; display converts with the
// location's IANA timezone only.
function epoch(e, tz, opts)
{
    if (!e) { return "--"; }
    try
    {
        return new Date(e * 1000).toLocaleString("en-US", Object.assign({ timeZone: tz || "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, opts || {}));
    }
    catch (err) { return new Date(e * 1000).toISOString(); }
}

function ago(e, now)
{
    if (!e) { return "never"; }
    const s = (now || Math.floor(Date.now() / 1000)) - e;
    if (s < 60) { return s + " s ago"; }
    if (s < 3600) { return Math.floor(s / 60) + " min ago"; }
    if (s < 86400) { return Math.floor(s / 3600) + " h ago"; }
    return Math.floor(s / 86400) + " d ago";
}

// Compact elapsed time for the footer uptime: 45s, 12m, 5h, 3d.
function duration(seconds)
{
    const s = Math.max(0, Math.floor(seconds || 0));
    if (s < 60) { return s + "s"; }
    if (s < 3600) { return Math.floor(s / 60) + "m"; }
    if (s < 86400) { return Math.floor(s / 3600) + "h"; }
    return Math.floor(s / 86400) + "d";
}

function uid(u) { return String(u).toLowerCase(); }

// A 12 hex digit id is shown as a MAC; anything else (host name, IMEI) as given.
function hardwareId(h)
{
    if (!h) { return ""; }
    const s = String(h);
    return /^[0-9A-F]{12}$/i.test(s) ? s.toUpperCase().match(/.{1,2}/g).join(":") : s;
}
const mac = hardwareId;

module.exports = { epoch, ago, duration, uid, mac, hardwareId };
