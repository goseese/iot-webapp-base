// Support requests (DECISIONS.md "Support requests", migration 0010, the support-request skill).
//
// Who is support for a request is decided in one place, canHandle(): superadmins always, plus users
// holding handle_support on the request's account (every request sent from it) or on its location
// (requests sent from that location). A request with no account is superadmin only. Support sees,
// answers, closes and reopens; the requester sees their own; anyone else gets the same 404 as a
// missing request (routes/support.js).
//
// Email only tells people something happened; the request, its thread, its files and who was
// emailed live in the database. A new request and every reply go to two groups as two separate
// messages: the site support list (SUPPORT_EMAILS) and the request's handlers. Each message has the
// whole group in To and Reply-To set to that same group, so Reply All stays inside the group and
// never mixes the site support team with an account's staff. The requester is never on either.
const env = require("../config/env");
const settings = require("../config/settings");
const logger = require("../config/logger");
const permissions = require("../permissions");
const mail = require("./mail");
const { knex, T, nowEpoch, insertId, isUniqueViolation } = require("../db/knex");

const MAX_DESCRIPTION = 4000;
const MAX_BYTES = 10 * 1024 * 1024;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_BIT = permissions.byName.handle_support.toString();

// key, email subject prefix, label (the modal's drop down and the email header).
const SEVERITIES =
[
    { key: "production-down", prefix: "[PRODUCTION DOWN]", label: "Very urgent, production is stopped" },
    { key: "urgent",          prefix: "[URGENT]",          label: "Urgent, but we can still function" },
    { key: "issue",           prefix: "[ISSUE]",           label: "Needs a look, not urgent" },
    { key: "feature-request", prefix: "[REQUEST]",         label: "Feature request, nice to have" }
];
const DEFAULT_SEVERITY = "issue";

const STATUS_LABELS = { open: "Waiting on support", answered: "Answered", closed: "Closed" };

// The list filters: Open and answered (default), Waiting on support, Answered, Closed, Everything.
const FILTERS =
[
    { key: "active",   label: "Open and answered", statuses: ["open", "answered"] },
    { key: "open",     label: "Waiting on support", statuses: ["open"] },
    { key: "answered", label: "Answered",           statuses: ["answered"] },
    { key: "closed",   label: "Closed",             statuses: ["closed"] },
    { key: "all",      label: "Everything",         statuses: null }
];

// File allowlist: extension to stored type. The type is never taken from the browser. Only the
// INLINE types are shown in the page; everything else downloads.
const FILE_TYPES =
{
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
    pdf: "application/pdf", csv: "text/csv", txt: "text/plain", log: "text/plain",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword"
};
const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const ADDRESS_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function severityOf(key)
{
    return SEVERITIES.find((s) => s.key === key) || SEVERITIES.find((s) => s.key === DEFAULT_SEVERITY);
}

function filterOf(key)
{
    return FILTERS.find((f) => f.key === key) || FILTERS[0];
}

// The stored type for a file name, or null when the extension is not allowed.
function fileType(filename)
{
    const m = /\.([a-z0-9]+)$/i.exec(String(filename || ""));
    return m ? (FILE_TYPES[m[1].toLowerCase()] || null) : null;
}

// The file's own name without any path, control characters or quotes, cut to the column.
function cleanFilename(name)
{
    const base = String(name || "").split(/[\\/]/).pop();
    return base.replace(/[\x00-\x1f\x7f"]/g, "").trim().slice(0, 255) || "file";
}

// Addresses separated by commas, semicolons or white space. Duplicates dropped.
function parseAddresses(value)
{
    const list = [];
    const bad = [];
    const seen = new Set();
    for (const part of String(value || "").split(/[,;\s]+/))
    {
        const a = part.trim();
        if (!a) { continue; }
        if (!ADDRESS_RE.test(a)) { bad.push(a); continue; }
        if (seen.has(a.toLowerCase())) { continue; }
        seen.add(a.toLowerCase());
        list.push(a);
    }
    return { list: list, bad: bad };
}

// YYYYMMDD-HHMMSS in UTC.
function makeRef(epoch)
{
    const d = new Date(epoch * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "-" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

function clean(text, max)
{
    return String(text || "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

// "Jeff Seese (jseese)", or the username alone when there is no display name.
function nameOf(person)
{
    return person.display_name ? person.display_name + " (" + person.username + ")" : String(person.username);
}

// The page a request was sent from: a path on this site, kept with its query string, never a host
// (Jeff, Oct 2026). Anything that is not a plain local path ("//host", a scheme, backslashes,
// spaces) is dropped. The title is the breadcrumb and tab the modal read off the page.
function cleanPage(url, title)
{
    const u = String(url || "").trim();
    const ok = u.length <= 2048 && /^\/(?![\/\\])[^\s\\]*$/.test(u);
    return { url: ok ? u : null, title: ok ? (String(title || "").replace(/\s+/g, " ").trim().slice(0, 200) || null) : null };
}

function linkFor(r)
{
    return new URL("/support/" + String(r.uid).toLowerCase(), env.appUrl).toString();
}

function pageLink(r)
{
    return r.page_url ? new URL(r.page_url, env.appUrl).toString() : null;
}

function supportList()
{
    return parseAddresses(settings.get("SUPPORT_EMAILS", "")).list;
}

// Sender on every support email, so mail rules can match on it; blank uses the site's normal From.
function fromAddress()
{
    return settings.get("SUPPORT_FROM_ADDRESS", "") || mail.fromAddress();
}

function sizeText(bytes)
{
    if (bytes >= 1048576) { return (bytes / 1048576).toFixed(1) + " MB"; }
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

// The mail rule friendly header every support email body starts with.
function keyBlock(r)
{
    return "Account: " + (r.account_name || "Not specified") + "\n" +
        "Location: " + (r.location_name || "Not specified") + "\n" +
        "User: " + nameOf(r) + ", " + r.email + "\n" +
        "Severity: " + severityOf(r.severity).label + "\n" +
        "Reference: " + r.ref + "\n";
}

// [ISSUE] Support request 20261006-033028 from Jeff (jeff), Corporate Mobile Housing
function subjectFor(r, what)
{
    return severityOf(r.severity).prefix + " Support request " + r.ref + " " + what + (r.account_name ? ", " + r.account_name : "");
}

function replyAllLine(audience)
{
    return audience === "support"
        ? "Reply All reaches the site support team only, never the requester or the account's own support handlers. Answer on the request page so the requester is told."
        : "Reply All reaches this account's support handlers only, never the requester or the site support team. Answer on the request page so the requester is told.";
}

function newRequestText(r, files, audience)
{
    const page = pageLink(r);
    const lines = [keyBlock(r)];
    lines.push("Page: " + (page ? (r.page_title ? r.page_title + "\n" : "") + page : "Not specified"));
    lines.push("Browser: " + (r.user_agent || "Not specified"));
    lines.push("Viewport: " + (r.viewport || "Not specified"));
    lines.push("Server request id: " + (r.request_id || "Not specified"));
    lines.push("Attachments: " + (files.length ? files.map((f) => f.filename + " (" + sizeText(f.data.length) + ")").join(", ") : "none"));
    lines.push("");
    lines.push("Open the request: " + linkFor(r));
    lines.push(replyAllLine(audience));
    lines.push("");
    lines.push("Description:");
    lines.push(r.description);
    return lines.join("\n");
}

function replyText(r, author, isStaff, body, audience, requesterEmailed)
{
    const lines = [keyBlock(r)];
    lines.push("Reply from: " + nameOf(author) + (isStaff ? ", support" : ", the requester"));
    lines.push("Status: " + STATUS_LABELS[r.status]);
    if (isStaff) { lines.push("Requester emailed: " + (requesterEmailed ? "yes" : "no")); }
    lines.push("");
    lines.push("Open the request: " + linkFor(r));
    lines.push(replyAllLine(audience));
    lines.push("");
    lines.push("Reply:");
    lines.push(body);
    return lines.join("\n");
}

// One request with the names the pages and emails need.
function fullQuery()
{
    return knex(T("support_requests") + " as r")
        .join(T("users") + " as u", "u.id", "r.user_id")
        .leftJoin(T("accounts") + " as a", "a.id", "r.account_id")
        .leftJoin(T("locations") + " as l", "l.id", "r.location_id")
        .select("r.*", "u.username", "u.display_name", "u.email", "u.email_bounced", "u.delete_epoch as user_delete_epoch",
            "a.name as account_name", "a.uid as account_uid", "l.name as location_name", "l.uid as location_uid");
}

function byId(id)
{
    return fullQuery().where("r.id", id).first();
}

async function findByUid(uid)
{
    if (!GUID_RE.test(String(uid || ""))) { return null; }
    return (await fullQuery().where("r.uid", uid).first()) || null;
}

// The one rule for who is support for a request.
async function canHandle(user, r)
{
    if (!user || !r) { return false; }
    if (user.is_superadmin) { return true; }
    if (!r.account_id) { return false; }
    const row = await knex(T("grants"))
        .where({ grantee_type: "user", grantee_id: user.id })
        .where(function ()
        {
            this.where({ scope_type: "account", scope_id: r.account_id });
            if (r.location_id) { this.orWhere({ scope_type: "location", scope_id: r.location_id }); }
        })
        .whereRaw("(permission_bits & ?) = ?", [HANDLE_BIT, HANDLE_BIT])
        .first("id");
    return !!row;
}

// The request for this viewer (its requester or support), or null: the caller answers not found.
async function forViewer(uid, user)
{
    const r = await findByUid(uid);
    if (!r || !user) { return null; }
    if (r.user_id === user.id || await canHandle(user, r)) { return r; }
    return null;
}

// Users holding handle_support at the request's account or location, leaving out superadmins (they
// have the support list), the excluded ids (requester, reply author), deleted users, bounced
// addresses and any address already on SUPPORT_EMAILS.
async function handlers(r, excludeIds)
{
    if (!r.account_id) { return []; }
    const rows = await knex(T("users") + " as u")
        .join(T("grants") + " as g", function ()
        {
            this.on("g.grantee_id", "u.id").andOnVal("g.grantee_type", "user");
        })
        .where(function ()
        {
            this.where(function () { this.where("g.scope_type", "account").andWhere("g.scope_id", r.account_id); });
            if (r.location_id)
            {
                this.orWhere(function () { this.where("g.scope_type", "location").andWhere("g.scope_id", r.location_id); });
            }
        })
        .whereRaw("(g.permission_bits & ?) = ?", [HANDLE_BIT, HANDLE_BIT])
        .whereNull("u.delete_epoch")
        .where("u.is_superadmin", false)
        .where("u.email_bounced", false)
        .whereNotIn("u.id", (excludeIds || []).filter((x) => x))
        .distinct("u.id", "u.email", "u.username", "u.display_name")
        .orderBy("u.id");
    const team = new Set(supportList().map((a) => a.toLowerCase()));
    return rows.filter((u) => u.email && !team.has(String(u.email).toLowerCase()));
}

// One message to one group: every address in To, Reply-To the same group (none for the requester,
// whose replies are not read), then one recipients row per address. Recording failures are logged,
// never thrown. Returns true when the message went out.
async function sendToGroup(r, messageId, audience, recipients, subject, text, files)
{
    if (!recipients.length) { return false; }
    const to = recipients.map((x) => x.address);
    let result = { ok: false, notificationId: null };
    try
    {
        result = await mail.send(
        {
            kind: "support",
            to: to,
            replyTo: audience === "requester" ? [] : to,
            from: fromAddress(),
            recipientType: audience === "requester" ? "user" : "address",
            recipientId: audience === "requester" ? recipients[0].userId : null,
            subject: subject,
            text: text,
            attachments: files && files.length ? files : undefined
        });
    }
    catch (err)
    {
        logger.error({ err: err.message, request: r.id, audience: audience }, "support: email send threw");
    }
    try
    {
        const now = nowEpoch();
        await knex(T("support_recipients")).insert(recipients.map((x) => (
        {
            support_request_id: r.id,
            support_message_id: messageId || null,
            audience: audience,
            address: String(x.address).slice(0, 254),
            user_id: x.userId || null,
            outcome: result.ok ? "sent" : "failed",
            notification_id: result.notificationId || null,
            created_epoch: now
        })));
    }
    catch (err)
    {
        logger.warn({ err: err.message, request: r.id, audience: audience }, "support: recipients not recorded");
    }
    return !!result.ok;
}

function canEmail(r)
{
    return !!r.email && !r.user_delete_epoch && !r.email_bounced;
}

// input: { user, accountId, locationId, severity, description, pageUrl, pageTitle, userAgent,
// viewport, requestId, copyMe, files: [{ filename, contentType, data }] }. The description is
// checked by the route. Saved first; a failed email never fails the request.
// Returns { request, emailed }.
async function create(input)
{
    const now = nowEpoch();
    const page = cleanPage(input.pageUrl, input.pageTitle);
    const files = (input.files || []).map((f) => ({ filename: cleanFilename(f.filename), contentType: f.contentType, data: f.data }));
    const row =
    {
        user_id: input.user.id,
        account_id: input.accountId || null,
        location_id: input.locationId || null,
        severity: severityOf(input.severity).key,
        status: "open",
        description: clean(input.description, MAX_DESCRIPTION),
        page_url: page.url,
        page_title: page.title,
        user_agent: String(input.userAgent || "").slice(0, 512) || null,
        viewport: /^\d{1,5}x\d{1,5}$/.test(String(input.viewport || "")) ? String(input.viewport) : null,
        request_id: String(input.requestId || "").slice(0, 16) || null,
        email_sent: false,
        created_epoch: now,
        updated_epoch: now
    };

    // The ref is the creation second; on a clash, the next second, up to 10 tries. Postgres aborts
    // a transaction on any error, so a clash retries the whole transaction.
    let id = null;
    for (let attempt = 0; attempt < 10 && id === null; attempt++)
    {
        const ref = makeRef(now + attempt);
        try
        {
            id = await knex.transaction(async (trx) =>
            {
                const ids = await trx(T("support_requests")).insert(Object.assign({}, row, { ref: ref })).returning("id");
                const newId = insertId(ids);
                for (const f of files)
                {
                    await trx(T("support_attachments")).insert({ support_request_id: newId, filename: f.filename, content_type: f.contentType, size_bytes: f.data.length, data: f.data, created_epoch: now });
                }
                return newId;
            });
        }
        catch (err)
        {
            if (isUniqueViolation(err) && err.constraint === "ux_support_requests_ref") { continue; }
            throw err;
        }
    }
    if (id === null) { throw new Error("support: no free reference in 10 tries"); }

    const r = await byId(id);
    const subject = subjectFor(r, "from " + nameOf(r));

    const team = supportList();
    let supportOk = false;
    if (team.length)
    {
        supportOk = await sendToGroup(r, null, "support", team.map((a) => ({ address: a, userId: null })), subject, newRequestText(r, files, "support"), files);
        if (supportOk) { await knex(T("support_requests")).where({ id: r.id }).update({ email_sent: true }); }
    }
    else
    {
        logger.warn({ ref: r.ref }, "support: SUPPORT_EMAILS is empty, the support list was not emailed");
    }

    const hs = await handlers(r, [r.user_id]);
    const handlersOk = hs.length
        ? await sendToGroup(r, null, "handlers", hs.map((u) => ({ address: u.email, userId: u.id })), subject, newRequestText(r, files, "handlers"), files)
        : false;

    // The requester's copy goes only if at least one support email went out; its failure is only logged.
    if (input.copyMe && (supportOk || handlersOk) && canEmail(r))
    {
        const text = [
            "This is your copy of support request " + r.ref + ". Support has been notified.",
            "Replies appear on the request's page, and you get an email with a link when support answers:",
            linkFor(r),
            "Replies to this email are not read.",
            "",
            keyBlock(r),
            "Description:",
            r.description
        ].join("\n");
        await sendToGroup(r, null, "requester", [{ address: r.email, userId: r.user_id }], severityOf(r.severity).prefix + " Support request " + r.ref + ", your copy", text, files);
    }
    return { request: await byId(id), emailed: supportOk || handlersOk };
}

// isStaff: support answering someone else's request (the route decides). A support reply makes the
// request answered and emails the requester; a requester reply makes it open again (reopening a
// closed one). Both groups get every reply, the author left out of both.
// Returns { error } or { request, requesterEmailed }.
async function reply(r, author, isStaff, text)
{
    const body = clean(text, MAX_DESCRIPTION);
    if (!body) { return { error: "Type a reply first." }; }
    const now = nowEpoch();
    const messageId = await knex.transaction(async (trx) =>
    {
        const ids = await trx(T("support_messages")).insert({ support_request_id: r.id, author_id: author.id, is_staff: !!isStaff, body: body, created_epoch: now }).returning("id");
        await trx(T("support_requests")).where({ id: r.id }).update({ status: isStaff ? "answered" : "open", updated_epoch: now, closed_epoch: null, closed_by: null });
        return insertId(ids);
    });
    const fresh = await byId(r.id);

    let requesterEmailed = false;
    if (isStaff && canEmail(fresh))
    {
        const site = settings.siteName();
        const mailText = [
            "Hello " + (fresh.display_name || fresh.username) + ",",
            "",
            site + " support replied to your support request " + fresh.ref + ":",
            "",
            body,
            "",
            "Read the whole request and reply here:",
            linkFor(fresh),
            "",
            "Replies to this email are not read. Please reply on the site."
        ].join("\n");
        requesterEmailed = await sendToGroup(fresh, messageId, "requester", [{ address: fresh.email, userId: fresh.user_id }], subjectFor(fresh, "reply from " + site + " support"), mailText);
    }

    const subject = subjectFor(fresh, "reply from " + nameOf(author));
    const authorEmail = String(author.email || "").toLowerCase();
    const team = supportList().filter((a) => a.toLowerCase() !== authorEmail);
    if (team.length)
    {
        await sendToGroup(fresh, messageId, "support", team.map((a) => ({ address: a, userId: null })), subject, replyText(fresh, author, isStaff, body, "support", requesterEmailed));
    }
    const hs = await handlers(fresh, [fresh.user_id, author.id]);
    if (hs.length)
    {
        await sendToGroup(fresh, messageId, "handlers", hs.map((u) => ({ address: u.email, userId: u.id })), subject, replyText(fresh, author, isStaff, body, "handlers", requesterEmailed));
    }
    return { request: fresh, requesterEmailed: requesterEmailed };
}

// Support only (checked by the route). action: close | reopen.
async function setStatus(r, action, user)
{
    const now = nowEpoch();
    const patch = action === "close"
        ? { status: "closed", closed_epoch: now, closed_by: user.id, updated_epoch: now }
        : { status: "open", closed_epoch: null, closed_by: null, updated_epoch: now };
    await knex(T("support_requests")).where({ id: r.id }).update(patch);
}

function messages(requestId)
{
    return knex(T("support_messages") + " as m")
        .join(T("users") + " as u", "u.id", "m.author_id")
        .where("m.support_request_id", requestId)
        .orderBy("m.id")
        .select("m.*", "u.username", "u.display_name");
}

// Without the file data.
function attachments(requestId)
{
    return knex(T("support_attachments")).where({ support_request_id: requestId }).orderBy("id").select("id", "filename", "content_type", "size_bytes", "created_epoch");
}

async function attachment(requestId, id)
{
    return (await knex(T("support_attachments")).where({ support_request_id: requestId, id: id }).first()) || null;
}

function recipients(requestId)
{
    return knex(T("support_recipients")).where({ support_request_id: requestId }).orderBy("id");
}

function isInline(contentType)
{
    return INLINE_TYPES.has(contentType);
}

// The lists: newest activity first, 500 at most, with the first part of the description.
function listQuery()
{
    return knex(T("support_requests") + " as r")
        .join(T("users") + " as u", "u.id", "r.user_id")
        .leftJoin(T("accounts") + " as a", "a.id", "r.account_id")
        .leftJoin(T("locations") + " as l", "l.id", "r.location_id")
        .select("r.id", "r.uid", "r.ref", "r.status", "r.severity", "r.email_sent", "r.created_epoch", "r.updated_epoch", "r.account_id", "r.location_id",
            knex.raw("left(r.description, 140) as summary"), "u.username", "u.display_name", "u.email",
            "a.name as account_name", "l.name as location_name")
        .orderBy("r.updated_epoch", "desc")
        .limit(500);
}

function withFilter(q, filterKey)
{
    const f = filterOf(filterKey);
    if (f.statuses) { q.whereIn("r.status", f.statuses); }
    return q;
}

function listForUser(userId)
{
    return listQuery().where("r.user_id", userId);
}

function listAll(filterKey)
{
    return withFilter(listQuery(), filterKey);
}

// The handle_support grants this user has inside one account: { all } when they handle every
// request sent from it (an account grant, or a superadmin), else { locationIds }, else null.
async function scopeIn(user, accountId)
{
    if (!user) { return null; }
    if (user.is_superadmin) { return { all: true, locationIds: [] }; }
    const rows = await knex(T("grants") + " as g")
        .leftJoin(T("locations") + " as l", function ()
        {
            this.on("l.id", "g.scope_id").andOnVal("g.scope_type", "location");
        })
        .where({ "g.grantee_type": "user", "g.grantee_id": user.id })
        .whereRaw("(g.permission_bits & ?) = ?", [HANDLE_BIT, HANDLE_BIT])
        .where(function ()
        {
            this.where(function () { this.where("g.scope_type", "account").andWhere("g.scope_id", accountId); })
                .orWhere("l.account_id", accountId);
        })
        .select("g.scope_type", "g.scope_id");
    if (rows.some((g) => g.scope_type === "account")) { return { all: true, locationIds: [] }; }
    const locationIds = rows.filter((g) => g.scope_type === "location").map((g) => g.scope_id);
    return locationIds.length ? { all: false, locationIds: locationIds } : null;
}

// Account > Support: the account's requests this user handles, or null when they are not support there.
async function listForAccount(user, accountId, filterKey)
{
    const scope = await scopeIn(user, accountId);
    if (!scope) { return null; }
    const q = withFilter(listQuery(), filterKey).where("r.account_id", accountId);
    if (!scope.all) { q.whereIn("r.location_id", scope.locationIds); }
    return q;
}

// The superadmin badge: requests waiting on support.
async function openCount()
{
    const r = await knex(T("support_requests")).where({ status: "open" }).count("id as n").first();
    return Number(r.n);
}

// The accounts this user is support for, each with its count of requests waiting on support, for
// the Account > Support menu item and its badge. Computed once per page (app.js), from the database.
// Returns { all, counts }: all is true for superadmins (support for every account); counts maps an
// account id to its waiting count (every handled account is present, 0 included, unless all).
async function openByAccount(user)
{
    const out = { all: false, counts: new Map() };
    if (!user) { return out; }
    if (user.is_superadmin)
    {
        out.all = true;
        const rows = await knex(T("support_requests")).where({ status: "open" }).whereNotNull("account_id").groupBy("account_id").select("account_id").count("id as n");
        rows.forEach((x) => out.counts.set(x.account_id, Number(x.n)));
        return out;
    }
    const grants = await knex(T("grants") + " as g")
        .leftJoin(T("locations") + " as l", function ()
        {
            this.on("l.id", "g.scope_id").andOnVal("g.scope_type", "location");
        })
        .where({ "g.grantee_type": "user", "g.grantee_id": user.id })
        .whereRaw("(g.permission_bits & ?) = ?", [HANDLE_BIT, HANDLE_BIT])
        .select("g.scope_type", "g.scope_id", "l.account_id as location_account_id");
    if (!grants.length) { return out; }
    const accountIds = grants.filter((g) => g.scope_type === "account").map((g) => g.scope_id);
    const locations = grants.filter((g) => g.scope_type === "location" && g.location_account_id && !accountIds.includes(g.location_account_id));
    accountIds.forEach((id) => out.counts.set(id, 0));
    locations.forEach((g) => out.counts.set(g.location_account_id, 0));
    const locationIds = locations.map((g) => g.scope_id);
    const rows = await knex(T("support_requests"))
        .where({ status: "open" })
        .where(function ()
        {
            if (accountIds.length) { this.whereIn("account_id", accountIds); }
            if (locationIds.length) { this.orWhereIn("location_id", locationIds); }
        })
        .groupBy("account_id")
        .select("account_id")
        .count("id as n");
    rows.forEach((x) => { if (x.account_id) { out.counts.set(x.account_id, Number(x.n)); } });
    return out;
}

module.exports =
{
    MAX_DESCRIPTION, MAX_BYTES, SEVERITIES, DEFAULT_SEVERITY, STATUS_LABELS, FILTERS, FILE_TYPES,
    severityOf, filterOf, fileType, cleanFilename, parseAddresses, makeRef, nameOf, cleanPage, linkFor, pageLink,
    keyBlock, subjectFor, supportList, fromAddress, isInline,
    findByUid, forViewer, canHandle, handlers, create, reply, setStatus, sendToGroup,
    messages, attachments, attachment, recipients,
    listForUser, listAll, listForAccount, scopeIn, openCount, openByAccount
};
