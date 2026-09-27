// Support requests (DECISIONS.md "Support requests", migration 0003). A request is a conversation
// reached by its uid, and only its requester and superadmins may open it. Every reply is typed in
// the app; email only tells people there is something to read:
//   - a new request or a requester reply goes to SUPPORT_EMAILS as one message with every address
//     in To and Reply-To set to the same list, so the team can reply all to each other; the
//     requester is never a recipient or the Reply-To of that mail.
//   - a support reply goes to the requester with the text and the link; replies to it are not read.
// Status: open (needs a support answer), waiting (support answered), closed.
const env = require("../config/env");
const settings = require("../config/settings");
const logger = require("../config/logger");
const mail = require("./mail");
const { knex, T, nowEpoch, insertId } = require("../db/knex");

const MAX_SUBJECT = 150;
const MAX_BODY = 10000;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function supportAddresses()
{
    return String(settings.get("SUPPORT_EMAILS", "") || "")
        .split(/[,;\s]+/)
        .map((a) => a.trim())
        .filter((a) => EMAIL_RE.test(a));
}

function linkFor(request)
{
    return new URL("/support/" + String(request.uid).toLowerCase(), env.appUrl).toString();
}

function nameOf(user)
{
    return user.display_name || user.username;
}

// Only the requester and superadmins. Anyone else is shown a 404 by the caller.
function canSee(request, user)
{
    return !!request && !!user && (!!user.is_superadmin || request.user_id === user.id);
}

// A superadmin answering someone else's request writes as support; on their own request they are
// the requester like anyone else.
function isSupportReply(request, user)
{
    return !!user.is_superadmin && request.user_id !== user.id;
}

function byUid(uid)
{
    return knex(T("support_requests")).where({ uid: uid }).first();
}

function messages(requestId)
{
    return knex(T("support_messages") + " as m")
        .join(T("users") + " as u", "u.id", "m.user_id")
        .where("m.request_id", requestId)
        .orderBy([{ column: "m.epoch" }, { column: "m.id" }])
        .select("m.*", "u.username", "u.display_name");
}

// The requester and the account, for the page and for emails.
async function context(request)
{
    const requester = await knex(T("users")).where({ id: request.user_id }).first();
    const account = request.account_id ? await knex(T("accounts")).where({ id: request.account_id }).first() : null;
    return { requester: requester, account: account };
}

function listForUser(userId)
{
    return knex(T("support_requests")).where({ user_id: userId }).orderBy("updated_epoch", "desc").limit(200);
}

// status: open | waiting | closed | all.
function listAll(status)
{
    const q = knex(T("support_requests") + " as r")
        .join(T("users") + " as u", "u.id", "r.user_id")
        .leftJoin(T("accounts") + " as a", "a.id", "r.account_id")
        .select("r.*", "u.username", "u.display_name", "u.email", "a.name as account_name")
        .orderBy("r.updated_epoch", "desc")
        .limit(500);
    if (status !== "all") { q.where("r.status", status); }
    return q;
}

async function countOpen()
{
    const r = await knex(T("support_requests")).where({ status: "open" }).count("id as n").first();
    return Number(r.n);
}

function clean(text, max)
{
    return String(text || "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

// Mail failures are recorded in notifications by services/mail; they never undo the request.
async function notifyTeam(request, author, body, isNew)
{
    const to = supportAddresses();
    if (to.length === 0)
    {
        logger.warn({ request: request.uid }, "support: SUPPORT_EMAILS is empty, nobody was emailed");
        return;
    }
    const { account } = await context(request);
    const site = settings.siteName();
    const who = nameOf(author) + " <" + author.email + ">";
    const text = [
        isNew ? "New support request from " + who : who + " replied to a support request",
        "Subject: " + request.subject,
        "Account: " + (account ? account.name : "not about a specific account"),
        "",
        body,
        "",
        "Open and answer it here:",
        linkFor(request),
        "",
        "This request is answered only on the site. Replying to this email reaches the support team, not the requester."
    ].join("\n");
    await mail.send({ kind: "support", to: to, replyTo: to, recipientType: "address", subject: "[" + site + " support] " + (isNew ? "" : "Re: ") + request.subject, text: text });
}

async function notifyRequester(request, body)
{
    const { requester } = await context(request);
    if (!requester || requester.delete_epoch || !requester.email) { return; }
    const site = settings.siteName();
    const text = [
        "Hello " + nameOf(requester) + ",",
        "",
        site + " support replied to your request \"" + request.subject + "\":",
        "",
        body,
        "",
        "Read the conversation and reply here:",
        linkFor(request),
        "",
        "Replies to this email are not read. Please reply on the site."
    ].join("\n");
    await mail.send({ kind: "support", to: requester.email, recipientType: "user", recipientId: requester.id, subject: "[" + site + " support] Re: " + request.subject, text: text });
}

// fields: { subject, body, accountId }. Returns { error } or { request }.
async function create(user, fields)
{
    const subject = clean(fields.subject, MAX_SUBJECT).replace(/\s+/g, " ");
    const body = clean(fields.body, MAX_BODY);
    if (!subject) { return { error: "Give the request a subject." }; }
    if (!body) { return { error: "Describe what you need help with." }; }
    const now = nowEpoch();
    const request = await knex.transaction(async (trx) =>
    {
        const rows = await trx(T("support_requests")).insert(
        {
            user_id: user.id,
            account_id: fields.accountId || null,
            subject: subject,
            status: "open",
            created_epoch: now,
            updated_epoch: now
        }).returning(["id", "uid"]);
        const id = insertId(rows);
        await trx(T("support_messages")).insert({ request_id: id, user_id: user.id, from_support: false, body: body, epoch: now });
        return trx(T("support_requests")).where({ id: id }).first();
    });
    await notifyTeam(request, user, body, true);
    return { request: request };
}

// Returns { error } or { request, fromSupport }.
async function reply(request, user, text)
{
    const body = clean(text, MAX_BODY);
    if (!body) { return { error: "Type a reply first." }; }
    const fromSupport = isSupportReply(request, user);
    const now = nowEpoch();
    await knex.transaction(async (trx) =>
    {
        await trx(T("support_messages")).insert({ request_id: request.id, user_id: user.id, from_support: fromSupport, body: body, epoch: now });
        // A support reply waits on the requester; a requester reply (even to a closed request)
        // needs an answer again.
        await trx(T("support_requests")).where({ id: request.id }).update({ status: fromSupport ? "waiting" : "open", updated_epoch: now, closed_epoch: null });
    });
    if (fromSupport) { await notifyRequester(request, body); }
    else { await notifyTeam(request, user, body, false); }
    return { request: await byUid(request.uid), fromSupport: fromSupport };
}

// Superadmins only (checked by the route). close: closed; reopen: open.
async function setStatus(request, action)
{
    const now = nowEpoch();
    const patch = action === "close"
        ? { status: "closed", closed_epoch: now, updated_epoch: now }
        : { status: "open", closed_epoch: null, updated_epoch: now };
    await knex(T("support_requests")).where({ id: request.id }).update(patch);
}

module.exports = { supportAddresses, linkFor, canSee, isSupportReply, byUid, messages, context, listForUser, listAll, countOpen, create, reply, setStatus, MAX_SUBJECT, MAX_BODY };
