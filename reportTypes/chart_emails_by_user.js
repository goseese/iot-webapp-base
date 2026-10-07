// Chart emails sent from the site, counted per user (the same sends as reportTypes/chart_emails.js).
const chartEmails = require("./chart_emails");

function utc(epoch) { return new Date(Number(epoch) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"; }

module.exports =
{
    slug: "chart_emails_by_user",
    displayName: "Chart emails by user",
    description: "How many charts each user emailed from the site in the window, with recipients and readings sent.",
    columns: ["User", "Emails sent", "Failed", "Recipients", "Readings", "First (UTC)", "Last (UTC)"],
    async rows(q)
    {
        const by = new Map();
        for (const e of await chartEmails.sends(q))
        {
            const u = by.get(e.user_id) || { name: e.display_name || e.username, sent: 0, failed: 0, recipients: 0, readings: 0, first: e.epoch, last: e.epoch };
            if (e.outcome === "sent") { u.sent++; u.recipients += Number(e.recipient_count); u.readings += Number(e.reading_count); }
            else { u.failed++; }
            u.last = e.epoch;
            by.set(e.user_id, u);
        }
        return Array.from(by.values()).sort((a, b) => b.sent - a.sent).map((u) => [u.name, u.sent, u.failed, u.recipients, u.readings, utc(u.first), utc(u.last)]);
    }
};
