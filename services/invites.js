// Invites (architecture 4.4): grants exist only for real users. An existing address gets an
// immediate grant and an "added" email; a new one gets an invite row. The caller's response
// is identical either way so addresses are never enumerable.
const crypto = require("crypto");
const env = require("../config/env");
const settings = require("../config/settings");
const { knex, T, nowEpoch } = require("../db/knex");
const users = require("../db/repos/users");
const invitesRepo = require("../db/repos/invites");
const grantsRepo = require("../db/repos/grants");
const mail = require("./mail");
const { audit } = require("./audit");

function hashOf(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

// input: { email, username, scopeType, scopeId, scopeName, bits, invitedBy (user row) }
async function invite(input)
{
    const email = input.email.trim().toLowerCase();
    const existingUser = await users.findByLogin(email);
    const now = nowEpoch();

    if (existingUser)
    {
        await grantsRepo.upsert(
        {
            grantee_type: "user", grantee_id: existingUser.id,
            scope_type: input.scopeType, scope_id: input.scopeId,
            permission_bits: input.bits.toString(), created_epoch: now, created_by: input.invitedBy.id
        });
        await mail.send(
        {
            kind: "invite", to: email, recipientType: "user", recipientId: existingUser.id,
            subject: "You have been added to " + input.scopeName + " on " + settings.siteName(),
            text: (input.invitedBy.display_name || input.invitedBy.username) + " added you to " + input.scopeName + ".\n\n" +
                  "Sign in: " + env.appUrl + "/login\n"
        });
        return { outcome: "added" };
    }

    const live = await invitesRepo.findLiveByEmail(email);
    if (live) { await invitesRepo.update(live.id, { cancelled_epoch: now }); }   // resend replaces

    const token = crypto.randomBytes(32).toString("base64url");
    await invitesRepo.insert(
    {
        email: email,
        username: input.username,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        permission_bits: input.bits.toString(),
        token_hash: hashOf(token),
        expires_epoch: now + settings.get("INVITE_DAYS", 7) * 86400,
        created_epoch: now,
        created_by: input.invitedBy.id
    });
    await mail.send(
    {
        kind: "invite", to: email, recipientType: "address",
        subject: "You are invited to " + input.scopeName + " on " + settings.siteName(),
        text: (input.invitedBy.display_name || input.invitedBy.username) + " invited you to " + input.scopeName + ".\n\n" +
              "Accept and set your password: " + env.appUrl + "/invite/" + token + "\n\n" +
              "This link expires in " + settings.get("INVITE_DAYS", 7) + " days.\n"
    });
    return { outcome: "invited" };
}

// Resend: fresh token and expiry, old link dead, same scope and bits. Works for expired ones too.
async function resend(inviteRow, byUser)
{
    const now = nowEpoch();
    const token = crypto.randomBytes(32).toString("base64url");
    await invitesRepo.update(inviteRow.id, { token_hash: hashOf(token), expires_epoch: now + settings.get("INVITE_DAYS", 7) * 86400, cancelled_epoch: null });
    const scopeName = inviteRow.scope_type === "account"
        ? (await knex(T("accounts")).where({ id: inviteRow.scope_id }).first()).name
        : (await knex(T("locations")).where({ id: inviteRow.scope_id }).first()).name;
    return mail.send(
    {
        kind: "invite", to: inviteRow.email, recipientType: "address",
        subject: "You are invited to " + scopeName + " on " + settings.siteName(),
        text: (byUser.display_name || byUser.username) + " sent you a new invitation to " + scopeName + ".\n\n" +
              "Accept and set your password: " + env.appUrl + "/invite/" + token + "\n\n" +
              "This link expires in " + settings.get("INVITE_DAYS", 7) + " days. Earlier invitation links no longer work.\n"
    });
}

async function findValid(token)
{
    if (!token || token.length < 20) { return null; }
    const row = await invitesRepo.findByHash(hashOf(token));
    if (!row || row.accepted_epoch || row.cancelled_epoch || row.expires_epoch < nowEpoch()) { return null; }
    return row;
}

// Creates the user and the grant in one transaction. Returns the new user id.
async function accept(inviteRow, username, passwordHash)
{
    const now = nowEpoch();
    return knex.transaction(async (trx) =>
    {
        const userId = await users.insert(
        {
            username: username,
            email: inviteRow.email,
            password_hash: passwordHash,
            password_changed_epoch: now,
            created_epoch: now,
            created_by: inviteRow.created_by
        }, trx);
        await grantsRepo.upsert(
        {
            grantee_type: "user", grantee_id: userId,
            scope_type: inviteRow.scope_type, scope_id: inviteRow.scope_id,
            permission_bits: inviteRow.permission_bits, created_epoch: now, created_by: inviteRow.created_by
        }, trx);
        await invitesRepo.update(inviteRow.id, { accepted_epoch: now }, trx);
        const user = await trx(T("users")).where({ id: userId }).first();
        await audit(trx, { entityType: "user", entityUid: user.uid, entityName: username, field: "created", newValue: "invite accepted", actorType: "user", actorId: userId });
        return userId;
    });
}

module.exports = { invite, resend, findValid, accept };
