// Armed/disarmed (architecture 8.3): offline devices and active schedule windows disarm.
// Schedules attach at device or rule level and are evaluated in the location's timezone.
const { knex, T } = require("../../db/knex");

function localDowMinute(epoch, timezone)
{
    const d = new Date(epoch * 1000);
    let parts;
    try
    {
        parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    }
    catch (err)
    {
        parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    }
    const get = (t) => parts.find((p) => p.type === t).value;
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    const hour = Number(get("hour")) % 24;
    return { dow: dow, minute: hour * 60 + Number(get("minute")) };
}

function windowActive(schedule, epoch, timezone)
{
    const now = localDowMinute(epoch, timezone);
    if (schedule.end_minute >= schedule.start_minute)
    {
        return ((schedule.dow_mask >> now.dow) & 1) === 1 && now.minute >= schedule.start_minute && now.minute < schedule.end_minute;
    }
    // Crosses midnight: today's evening part, or the early part that started yesterday.
    const yesterday = (now.dow + 6) % 7;
    if (((schedule.dow_mask >> now.dow) & 1) === 1 && now.minute >= schedule.start_minute) { return true; }
    return ((schedule.dow_mask >> yesterday) & 1) === 1 && now.minute < schedule.end_minute;
}

// Returns null when armed, or a reason string when disarmed.
// location: optional row with alarm_mode; "offline" disarms every device in it (architecture 8.3).
async function disarmReason(device, rule, epoch, timezone, location)
{
    if (location && location.alarm_mode === "offline") { return "location offline"; }
    if (device.is_archived) { return "archived"; }
    if (device.is_offline) { return "offline"; }
    const links = await knex(T("alarm_schedule_links") + " as k").join(T("alarm_schedules") + " as s", "s.id", "k.schedule_id")
        .whereNull("s.delete_epoch")
        .where(function ()
        {
            this.where({ "k.entity_type": "device", "k.entity_id": device.id });
            if (rule) { this.orWhere({ "k.entity_type": "rule", "k.entity_id": rule.id }); }
        })
        .select("s.*");
    for (const s of links)
    {
        if (windowActive(s, epoch, timezone)) { return "schedule " + s.name; }
    }
    return null;
}

module.exports = { disarmReason, windowActive, localDowMinute };
