// Unclaimed devices for one account (DECISIONS "Unclaimed devices, per account"): MACs on no live
// device that a gateway in the account has heard (unclaimed_heard), with every location that
// heard each one, strongest signal first. Used by the account page and the location's Unclaimed
// view (the same view, filtered), and by auto claim (isIgnored). Claim, ignore and unignore live
// here so both pages share them.
const { knex, T, nowEpoch, isUniqueViolation } = require("../db/knex");
const deviceTypes = require("../deviceTypes");
const levels = require("./levels");

// The type an unclaimed MAC most likely is: the one its unit declared when it provisioned, else
// the registry's first model (a beacon's is the type slug, a LoRa node's a model name).
function typeFor(reg, declaredSlug)
{
    if (declaredSlug && deviceTypes.all[declaredSlug]) { return deviceTypes.all[declaredSlug]; }
    if (!reg || !reg.first_model) { return null; }
    return deviceTypes.all[reg.first_model] || deviceTypes.forModel(reg.first_model) || null;
}

// Signal percent of an RSSI heard from a device of this type: its rssi channel's radio.
function signalPct(type, rssi)
{
    const ch = type && (type.channels || []).find((c) => c.id === "rssi" && c.signal);
    return ch ? levels.signalPercent(ch.signal, rssi) : null;
}

// opts: accountId, locationIds (the account's locations the user can view), locationId (filter:
// heard by any gateway there), showIgnored. Rows are { mac, registry fields, type, heard: [...],
// best, ignored }; ignored rows only when showIgnored.
async function list(opts)
{
    if (!opts.locationIds.length) { return []; }
    const heard = await knex(T("unclaimed_heard") + " as h")
        .join(T("devices") + " as g", "g.id", "h.gateway_id")
        .join(T("locations") + " as l", "l.id", "g.location_id")
        .leftJoin(T("devices") + " as d", function ()
        {
            this.on("d.hardware_id", "h.mac").andOnNull("d.delete_epoch").andOn("d.is_archived", knex.raw("false"));
        })
        .whereNull("d.id")
        .whereNull("g.delete_epoch").where("g.is_archived", 0)
        .where("l.account_id", opts.accountId).whereIn("l.id", opts.locationIds).whereNull("l.delete_epoch")
        .select("h.mac", "h.last_heard_epoch", "h.last_rssi", "g.name as gateway_name", "g.uid as gateway_uid", "l.id as location_id", "l.uid as location_uid", "l.name as location_name");
    const macs = Array.from(new Set(heard.map((h) => h.mac)));
    if (!macs.length) { return []; }

    const byMac = new Map();
    for (let i = 0; i < macs.length; i += 500)
    {
        const chunk = macs.slice(i, i + 500);
        for (const r of await knex(T("device_registry")).whereIn("mac", chunk)) { byMac.set(r.mac, { reg: r }); }
        for (const c of await knex(T("device_credentials")).whereIn("mac", chunk).whereNull("delete_epoch").select("mac", "type_slug")) { if (byMac.has(c.mac)) { byMac.get(c.mac).declared = c.type_slug; } }
    }
    const ignored = new Set((await knex(T("unclaimed_ignored")).where({ account_id: opts.accountId }).pluck("mac")));

    const rows = [];
    for (const mac of macs)
    {
        const info = byMac.get(mac) || {};
        const type = typeFor(info.reg, info.declared);
        const places = heard.filter((h) => h.mac === mac).map((h) => Object.assign({}, h, { signal_pct: signalPct(type, h.last_rssi) }));
        if (opts.locationId && !places.some((p) => p.location_id === opts.locationId)) { continue; }
        const isIgnored = ignored.has(mac);
        if (isIgnored && !opts.showIgnored) { continue; }
        // Strongest first (RSSI; unknown last), then most recent.
        places.sort((a, b) => ((b.last_rssi === null ? -999 : b.last_rssi) - (a.last_rssi === null ? -999 : a.last_rssi)) || (b.last_heard_epoch - a.last_heard_epoch));
        rows.push(
        {
            mac: mac,
            registry: info.reg || null,
            type: type,
            heard: places,
            best: places[0],
            last_heard_epoch: Math.max.apply(null, places.map((p) => p.last_heard_epoch)),
            ignored: isIgnored
        });
    }
    rows.sort((a, b) => b.last_heard_epoch - a.last_heard_epoch);
    return rows;
}

// Is this MAC ignored by this account (account ignore) or, with accountId null, by a superadmin?
async function isIgnored(accountId, mac)
{
    const q = knex(T("unclaimed_ignored")).where({ mac: mac });
    if (accountId === null) { q.whereNull("account_id"); } else { q.where({ account_id: accountId }); }
    return !!(await q.first());
}

// Ignore or unignore a MAC for an account, or site wide (accountId null, superadmin page only).
// Recorded by the caller in the activity log (audit_log needs an entity uid, and a MAC has none).
async function setIgnored(accountId, mac, ignore, actor)
{
    const already = await isIgnored(accountId, mac);
    if (already === ignore) { return false; }
    if (ignore)
    {
        try { await knex(T("unclaimed_ignored")).insert({ account_id: accountId, mac: mac, ignored_by: actor ? actor.id : null, ignored_epoch: nowEpoch() }); }
        catch (err) { if (!isUniqueViolation(err)) { throw err; } }
    }
    else
    {
        const q = knex(T("unclaimed_ignored")).where({ mac: mac });
        if (accountId === null) { q.whereNull("account_id"); } else { q.where({ account_id: accountId }); }
        await q.del();
    }
    return true;
}

// Default name for a claimed device: the type's name and the last four of the MAC.
function defaultName(type, mac)
{
    return (type ? type.displayName : "Device") + " " + mac.slice(-4);
}

// Hearing rows are only for unplaced MACs; once one is placed they are dead weight.
function forget(mac)
{
    return knex(T("unclaimed_heard")).where({ mac: mac }).del();
}

module.exports = { list, isIgnored, setIgnored, defaultName, typeFor, signalPct, forget };
