// Add by MAC, the "already in use" conflict flow, archive, delete, reprovision
// (architecture 3.7, 3.7a, 3.8, 7.3).
const env = require("../config/env");
const settings = require("../config/settings");
const { knex, T, nowEpoch } = require("../db/knex");
const devicesRepo = require("../db/repos/devices");
const registry = require("../db/repos/registry");
const credentials = require("../db/repos/credentials");
const deviceTypes = require("../deviceTypes");
const deviceService = require("./devices");
const grants = require("./grants");
const provisioning = require("./provisioning");
const mail = require("./mail");
const { audit } = require("./audit");

// Looks up a typed MAC before adding: registry prefill and the conflict, if any.
async function lookup(mac, req)
{
    const norm = deviceService.normalizeMac(mac);
    const reg = await registry.findByMac(norm);
    const live = await devicesRepo.findLiveByHardwareId(norm);
    // Suggested type: the one the unit itself declared when it provisioned (migration 0020) wins over
    // a guess from the model string. It pre fills the add form (routes/locations.js lookup) and is
    // the fallback in addByMac when the form sends no type, so a unit that already provisioned can
    // be claimed from any add form without anyone choosing a type by hand.
    const unit = await credentials.forMac(norm);
    const declared = unit && unit.type_slug ? deviceTypes.all[unit.type_slug] || null : null;
    const guessed = reg && reg.first_model ? deviceTypes.forModel(reg.first_model) : null;
    const out = { mac: norm, registry: reg, suggestedType: declared || guessed, conflict: null };
    if (live)
    {
        const location = await knex(T("locations")).where({ id: live.location_id }).first();
        const canSee = await grants.can(req, location, "view");
        const canEdit = await grants.can(req, location, "edit");
        const canDelete = await grants.can(req, location, "delete");
        out.conflict =
        {
            device: live, location: location, visible: canSee,
            canArchiveOrMove: canEdit || location.membership_mode === "release",
            canDelete: canDelete
        };
    }
    return out;
}

// resolution: "archive" | "move" | "delete" | null (no conflict). Enforced server side again.
async function addByMac(input, req, actor)
{
    const look = await lookup(input.mac, req);
    const target = input.location;
    if (target.membership_mode === "locked" && !input.deliberate)
    {
        throw new Error("This location is locked. Unlock it before adding devices.");
    }
    if (look.conflict)
    {
        const c = look.conflict;
        if (input.resolution === "move")
        {
            if (!c.canArchiveOrMove) { throw new Error("You need edit permission at " + c.location.name + " to move this device."); }
            await knex.transaction(async (trx) =>
            {
                await trx(T("devices")).where({ id: c.device.id }).update({ location_id: target.id });
                await audit(trx, { entityType: "device", entityUid: c.device.uid, entityName: c.device.name, field: "location", oldValue: c.location.name, newValue: target.name, actorType: "user", actorId: actor.id, actorName: actor.username });
            });
            return { device: await devicesRepo.findById(c.device.id), action: "moved" };
        }
        if (input.resolution === "archive")
        {
            if (!c.canArchiveOrMove) { throw new Error("You need edit permission at " + c.location.name + " to archive this device."); }
            await archive(c.device, actor);
        }
        else if (input.resolution === "delete")
        {
            if (!c.canDelete) { throw new Error("You need delete permission at " + c.location.name + " to delete this device."); }
            await softDelete(c.device, actor);
        }
        else
        {
            throw new Error("This device is already in use.");
        }
    }
    const typeSlug = input.typeSlug || (look.suggestedType ? look.suggestedType.slug : null);
    if (!typeSlug) { throw new Error("Pick a device type."); }
    const device = await deviceService.create(
    {
        locationId: target.id, typeSlug: typeSlug, name: input.name, hardwareId: look.mac,
        model: look.registry ? look.registry.first_model : null, firmware: look.registry ? look.registry.last_firmware : null, createdBy: actor.id
    });
    await registry.touch(look.mac, { epoch: nowEpoch(), via: "manual", deviceUid: device.uid });
    return { device: device, action: "added", conflictResolved: look.conflict ? input.resolution : null };
}

// Request access: emails the owning account's admins and superadmins (architecture 7.3).
async function requestAccess(mac, req, actor, intendedLocation)
{
    const look = await lookup(mac, req);
    if (!look.conflict) { return; }
    const perm = require("../permissions");
    const account = await knex(T("accounts")).where({ id: look.conflict.location.account_id }).first();
    const admins = await knex(T("grants") + " as g").join(T("users") + " as u", "u.id", "g.grantee_id")
        .where({ "g.grantee_type": "user", "g.scope_type": "account", "g.scope_id": account.id }).whereNull("u.delete_epoch").select("u.*", "g.permission_bits");
    const recipients = admins.filter((a) => perm.has(a.permission_bits, perm.byName.grant));
    for (const s of await knex(T("users")).where({ is_superadmin: 1 }).whereNull("delete_epoch")) { if (!recipients.some((r) => r.id === s.id)) { recipients.push(s); } }
    const text = (actor.display_name || actor.username) + " (" + actor.email + ") is asking for access to device " + look.mac +
        " which is currently at " + look.conflict.location.name + " (" + account.name + ") as \"" + look.conflict.device.name + "\".\n" +
        "They want to add it to " + intendedLocation.name + ".\n\nOpen the device: " + env.appUrl + "/devices/" + String(look.conflict.device.uid).toLowerCase() + "\n";
    for (const r of recipients)
    {
        await mail.send({ kind: "system", to: r.email, recipientType: "user", recipientId: r.id, subject: settings.get("SITE_NAME", "DevMon") + " device access request: " + look.mac, text: text });
    }
    return recipients.length;
}

async function archive(device, actor)
{
    await knex.transaction(async (trx) =>
    {
        await trx(T("devices")).where({ id: device.id }).update({ is_archived: 1 });
        await trx(T("alarm_escalations")).whereIn("alarm_id", trx(T("alarms")).join(T("sensors"), T("sensors") + ".id", T("alarms") + ".sensor_id").where(T("sensors") + ".device_id", device.id).select(T("alarms") + ".id")).update({ is_stopped: 1 });
        await audit(trx, { entityType: "device", entityUid: device.uid, entityName: device.name, field: "archived", newValue: "1", actorType: "user", actorId: actor.id, actorName: actor.username });
    });
    await require("./alarms/engine").clearAllForDevice(device.id, nowEpoch(), "archived", { type: "user", id: actor.id }, "device archived");
}

async function unarchive(device, actor)
{
    if (device.hardware_id && await devicesRepo.findLiveByHardwareId(device.hardware_id)) { throw new Error("This device's hardware id is now in use elsewhere. Resolve that first."); }
    await knex.transaction(async (trx) =>
    {
        await trx(T("devices")).where({ id: device.id }).update({ is_archived: 0 });
        await audit(trx, { entityType: "device", entityUid: device.uid, entityName: device.name, field: "archived", oldValue: "1", newValue: "0", actorType: "user", actorId: actor.id, actorName: actor.username });
    });
}

// Soft delete cascades immediately (architecture 2). The unit behind it keeps its credentials and
// stays connected (migration 0020): deleting a placement only means its data has nowhere to go.
// Revoking a unit is Reprovision, not delete.
async function softDelete(device, actor)
{
    const now = nowEpoch();
    await require("./alarms/engine").clearAllForDevice(device.id, now, "archived", { type: "user", id: actor.id }, "device deleted");
    await knex.transaction(async (trx) =>
    {
        await trx(T("alarm_rules")).whereIn("sensor_id", trx(T("sensors")).where({ device_id: device.id }).select("id")).whereNull("delete_epoch").update({ delete_epoch: now });
        await trx(T("sensors")).where({ device_id: device.id }).whereNull("delete_epoch").update({ delete_epoch: now });
        await trx(T("devices")).where({ id: device.id }).update({ delete_epoch: now });
        await audit(trx, { entityType: "device", entityUid: device.uid, entityName: device.name, field: "deleted", actorType: "user", actorId: actor.id, actorName: actor.username });
    });
}

async function reprovision(device, actor)
{
    await provisioning.reset(device.id);
    await knex.transaction(async (trx) =>
    {
        await audit(trx, { entityType: "device", entityUid: device.uid, entityName: device.name, field: "credentials", newValue: "reset to pending", actorType: "user", actorId: actor.id, actorName: actor.username });
    });
}

async function rename(device, name, actor)
{
    await knex.transaction(async (trx) =>
    {
        await trx(T("devices")).where({ id: device.id }).update({ name: name });
        await audit(trx, { entityType: "device", entityUid: device.uid, entityName: device.name, field: "name", oldValue: device.name, newValue: name, actorType: "user", actorId: actor.id, actorName: actor.username });
    });
}

module.exports = { lookup, addByMac, requestAccess, archive, unarchive, softDelete, reprovision, rename };
