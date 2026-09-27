// Notification resolution (architecture 8.5, 8.6, 8.7). For an alarm event: find the attached
// alert groups, take recipients at the ladder's current levels (cumulative 1..N), run the
// ordered gates (each may only remove), write a notifications row per decision, send.
const env = require("../../config/env");
const settings = require("../../config/settings");
const logger = require("../../config/logger");
const { knex, T, nowEpoch } = require("../../db/knex");
const alarmsRepo = require("../../db/repos/alarms");
const notifications = require("../../db/repos/notifications");
const tags = require("../tags");
const tokens = require("../tokens");
const mail = require("../mail");
const metrics = require("../../metrics");
const { ORDER } = require("./ladder");

const CHANNELS = ["email", "sms"];
const TRANSITION_KEY = { raised: "raise", escalated: "escalate", de_escalated: "de_escalate", cleared: "clear", re_notified: "raise", suppressed: null };

// Groups attached to an alarm: explicit rule joins, the account default (unless the rule opted
// out), and groups whose tag query matches the sensor's effective tags. Union.
async function attachedGroups(ctx)
{
    const rule = ctx.rule_id ? await knex(T("alarm_rules")).where({ id: ctx.rule_id }).first() : null;
    const groups = new Map();
    const add = (g) => { if (g && !groups.has(g.id)) { groups.set(g.id, g); } };

    if (rule)
    {
        const explicit = await knex(T("alarm_rule_alert_groups") + " as j").join(T("alert_groups") + " as g", "g.id", "j.alert_group_id")
            .where("j.alarm_rule_id", rule.id).whereNull("g.delete_epoch").select("g.*");
        explicit.forEach(add);
    }
    if (!rule || rule.use_default_group)
    {
        add(await knex(T("alert_groups")).where({ account_id: ctx.account_id, is_default: 1 }).whereNull("delete_epoch").first());
    }
    const tagged = await knex(T("alert_groups")).where({ account_id: ctx.account_id }).whereNull("delete_epoch").whereNotNull("tag_query");
    if (tagged.length > 0)
    {
        const effective = await tags.effectiveForSensor({ id: ctx.sensor_id, device_id: ctx.device_id });
        for (const g of tagged)
        {
            if (tags.matches(tags.parseQuery(g.tag_query), effective, ctx.sensor_name)) { add(g); }
        }
    }
    return Array.from(groups.values());
}

async function usersWithAccess(locationId, accountId)
{
    const perm = require("../../permissions");
    const rows = await knex(T("grants") + " as g").join(T("users") + " as u", "u.id", "g.grantee_id")
        .where("g.grantee_type", "user").whereNull("u.delete_epoch")
        .where(function () { this.where({ "g.scope_type": "account", "g.scope_id": accountId }).orWhere({ "g.scope_type": "location", "g.scope_id": locationId }); })
        .select("u.*", "g.permission_bits");
    const seen = new Map();
    for (const r of rows)
    {
        if (perm.has(r.permission_bits, perm.byName.view) && !seen.has(r.id)) { seen.set(r.id, r); }
    }
    // Superadmins see everything, so "all with access" includes them.
    for (const s of await knex(T("users")).where({ is_superadmin: 1 }).whereNull("delete_epoch"))
    {
        if (!seen.has(s.id)) { seen.set(s.id, s); }
    }
    return Array.from(seen.values());
}

// Recipients for one group up to and including level N. Returns [{ type, id, row, ladderNote }].
async function recipientsForGroup(group, uptoLevel, ctx)
{
    const levels = await knex(T("alert_group_levels")).where({ alert_group_id: group.id }).where("level_no", "<=", uptoLevel).orderBy("level_no");
    const out = new Map();
    for (const level of levels)
    {
        const rows = await knex(T("alert_group_recipients")).where({ level_id: level.id });
        const note = "level " + level.level_no + " of " + group.name;
        for (const r of rows)
        {
            if (r.recipient_type === "user")
            {
                const u = await knex(T("users")).where({ id: r.recipient_id }).whereNull("delete_epoch").first();
                if (u && !out.has("user:" + u.id)) { out.set("user:" + u.id, { type: "user", id: u.id, row: u, ladderNote: note }); }
            }
            else if (r.recipient_type === "contact")
            {
                const c = await knex(T("contacts")).where({ id: r.recipient_id }).whereNull("delete_epoch").first();
                if (c && !out.has("contact:" + c.id)) { out.set("contact:" + c.id, { type: "contact", id: c.id, row: c, ladderNote: note }); }
            }
            else if (r.recipient_type === "all_access")
            {
                for (const u of await usersWithAccess(ctx.location_id, ctx.account_id))
                {
                    if (!out.has("user:" + u.id)) { out.set("user:" + u.id, { type: "user", id: u.id, row: u, ladderNote: note + " (all with access)" }); }
                }
            }
        }
    }
    return Array.from(out.values());
}

function rulePolicyAllows(rule, transitionKey, channel)
{
    if (!rule || !rule.channel_policy || !transitionKey) { return true; }
    try
    {
        const p = JSON.parse(rule.channel_policy);
        return !(p[transitionKey] && p[transitionKey][channel] === false);
    }
    catch (err) { return true; }
}

// Scope prefs: location -> account -> global, first non inherit wins (gate 4).
async function userPrefAllows(user, channel, ctx, eventKind, severity)
{
    const prefs = await knex(T("user_notification_prefs")).where({ user_id: user.id, channel: channel });
    const pick = (scopeType, scopeId) => prefs.find((p) => p.scope_type === scopeType && (scopeId === null || p.scope_id === scopeId));
    const chain = [pick("location", ctx.location_id), pick("account", ctx.account_id), pick("global", null)].filter(Boolean);
    const decided = chain.find((p) => p.enabled !== "inherit");
    if (decided && decided.enabled === "off") { return "turned off in notification preferences"; }
    const isClearing = eventKind === "cleared" || eventKind === "de_escalated";
    for (const p of chain)
    {
        const min = isClearing ? p.min_severity_clear : p.min_severity_raise;
        if (min && ORDER[severity] < ORDER[min]) { return "below minimum severity " + min; }
        if (p.tag_query)
        {
            const effective = await tags.effectiveForSensor({ id: ctx.sensor_id, device_id: ctx.device_id });
            if (!tags.matches(tags.parseQuery(p.tag_query), effective, ctx.sensor_name)) { return "tag filter"; }
        }
    }
    return null;
}

// Ordered gates; returns null (send) or a plain words reason (suppressed).
async function gate(recipient, channel, ctx, rule, eventKind, severity)
{
    const now = nowEpoch();
    if (ctx.account_muted) { return "account notifications muted"; }
    if (ctx.location_muted) { return "location notifications muted"; }
    if (!rulePolicyAllows(rule, TRANSITION_KEY[eventKind], channel)) { return "rule policy for " + TRANSITION_KEY[eventKind] + " " + channel; }
    if (recipient.type === "user")
    {
        const u = recipient.row;
        if (channel === "email" && !u.email_enabled) { return "email turned off by user"; }
        if (channel === "email" && u.email_bounced) { return "email address bounced"; }
        if (channel === "email" && u.email_paused_until_epoch && u.email_paused_until_epoch > now) { return "email paused by user"; }
        if (channel === "sms" && !u.sms_enabled) { return "sms turned off by user"; }
        if (channel === "sms" && u.sms_paused_until_epoch && u.sms_paused_until_epoch > now) { return "sms paused by user"; }
        if (channel === "sms" && !u.phone) { return "no mobile number"; }
        const pref = await userPrefAllows(u, channel, ctx, eventKind, severity);
        if (pref) { return pref; }
    }
    else
    {
        const c = recipient.row;
        if (channel === "email" && !c.email) { return "contact has no email"; }
        if (channel === "sms" && (!c.phone || c.sms_opted_out)) { return c.sms_opted_out ? "contact opted out of sms" : "contact has no phone"; }
    }
    if (channel === "sms" && settings.get("SMS_DRIVER", "none") === "none") { return "no sms driver configured"; }
    return null;
}

function displayValue(ctx, value)
{
    if (value === null || value === undefined) { return ""; }
    const m = metrics.get(ctx.metric);
    const unit = ctx.display_unit || m.canonical;
    const v = metrics.fromCanonical(ctx.metric, value, unit);
    return v.toFixed(metrics.precision(ctx.metric, unit)) + (unit ? " " + unit : "");
}

function subjectFor(ctx, eventKind, severity)
{
    const site = settings.siteName();
    const what = { raised: severity.toUpperCase(), escalated: "ESCALATED to " + severity, de_escalated: "lowered to " + severity, cleared: "CLEARED", re_notified: "still " + severity.toUpperCase() }[eventKind] || eventKind;
    return "[" + site + "] " + what + ": " + ctx.sensor_name + " on " + ctx.device_name + " at " + ctx.location_name;
}

function bodyFor(ctx, eventKind, severity, value, comment, actionUrl, ladderNote)
{
    const lines =
    [
        ctx.sensor_name + " on " + ctx.device_name + " (" + ctx.location_name + ", " + ctx.account_name + ")",
        "Event: " + eventKind.replace("_", " ") + (severity ? ", severity " + severity : ""),
        "Direction: " + ctx.direction,
        value !== null && value !== undefined ? "Value: " + displayValue(ctx, value) : null,
        "Since: " + new Date(ctx.raised_epoch * 1000).toISOString(),
        comment ? "Note: " + comment : null,
        "",
        actionUrl ? "Acknowledge, ignore or clear: " + actionUrl : null,
        "Details: " + env.appUrl + "/alarms/" + String(ctx.uid).toLowerCase(),
        "",
        ladderNote ? "Sent as " + ladderNote + "." : null
    ].filter((l) => l !== null);
    return lines.join("\n") + "\n";
}

// Main entry. options: { eventId, eventKind, severity, value, comment, uptoLevelByGroup? }
async function notify(alarmId, options)
{
    const ctx = await alarmsRepo.context(alarmId);
    if (!ctx) { return; }
    const rule = ctx.rule_id ? await knex(T("alarm_rules")).where({ id: ctx.rule_id }).first() : null;
    const groups = await attachedGroups(ctx);
    if (groups.length === 0)
    {
        await notifications.insert({ kind: "alarm", channel: "email", recipient_type: "address", address: "(nobody)", alarm_event_id: options.eventId, outcome: "suppressed", reason: "no alert group attached", subject: subjectFor(ctx, options.eventKind, options.severity || ctx.severity) });
        return;
    }

    const severity = options.severity || ctx.severity;
    const linkMinutes = settings.get("RENOTIFY_MINUTES", 60) * 4;
    const sent = new Set();
    for (const group of groups)
    {
        const esc = await knex(T("alarm_escalations")).where({ alarm_id: alarmId, alert_group_id: group.id }).first();
        const upto = (options.uptoLevelByGroup && options.uptoLevelByGroup[group.id]) || (esc ? esc.current_level : 1);
        const recipients = await recipientsForGroup(group, upto, ctx);
        for (const r of recipients)
        {
            const key = r.type + ":" + r.id;
            if (sent.has(key)) { continue; }
            sent.add(key);
            for (const channel of CHANNELS)
            {
                const reason = await gate(r, channel, ctx, rule, options.eventKind, severity);
                const address = channel === "email" ? r.row.email : r.row.phone;
                if (reason)
                {
                    await notifications.insert({ kind: "alarm", channel: channel, recipient_type: r.type, recipient_id: r.id, address: address || "", alarm_event_id: options.eventId, ladder_note: r.ladderNote, outcome: "suppressed", reason: reason, subject: subjectFor(ctx, options.eventKind, severity) });
                    continue;
                }
                if (channel === "sms")
                {
                    const sms = require("../sms").active();
                    const smsText = subjectFor(ctx, options.eventKind, severity) + (options.value !== null && options.value !== undefined ? " " + displayValue(ctx, options.value) : "") + " " + env.appUrl + "/alarms/" + String(ctx.uid).toLowerCase();
                    const nid = await notifications.insert({ kind: "alarm", channel: "sms", recipient_type: r.type, recipient_id: r.id, address: address, alarm_event_id: options.eventId, ladder_note: r.ladderNote, outcome: "failed", reason: "not attempted", provider: sms.name, subject: subjectFor(ctx, options.eventKind, severity), body: smsText, sender: settings.get("TWILIO_FROM_NUMBER", "") || null });
                    const result = await sms.send({ to: address, text: smsText }).catch((err) => ({ ok: false, reason: err.message }));
                    await notifications.update(nid, result.ok ? { outcome: "sent", reason: null, provider_message_id: result.messageId || null, provider_response: result.raw ? JSON.stringify(result.raw).slice(0, 8000) : null } : { outcome: "failed", reason: (result.reason || "send failed").slice(0, 200), provider_response: result.raw ? JSON.stringify(result.raw).slice(0, 8000) : null });
                    continue;
                }

                // Single use action link bound to recipient + alarm; a newer message replaces it (8.7).
                let actionUrl = null;
                if (options.eventKind !== "cleared")
                {
                    const token = await tokens.issue("alarm_action", "alarm", alarmId, linkMinutes * 60, { recipientType: r.type, recipientId: r.id });
                    actionUrl = env.appUrl + "/a/" + token;
                }
                await mail.send(
                {
                    kind: "alarm", to: address, recipientType: r.type, recipientId: r.id, alarmEventId: options.eventId, ladderNote: r.ladderNote,
                    subject: subjectFor(ctx, options.eventKind, severity),
                    text: bodyFor(ctx, options.eventKind, severity, options.value, options.comment, actionUrl, r.ladderNote)
                });
            }
        }
    }
    await alarmsRepo.updateAlarm(alarmId, { last_notified_epoch: nowEpoch() });
    logger.info({ alarm: alarmId, event: options.eventKind, recipients: sent.size }, "alarm notifications resolved");
}

module.exports = { notify, attachedGroups, gate, displayValue };
