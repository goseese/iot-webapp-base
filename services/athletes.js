// Athletes and wristbands (DECISIONS.md "Athletes and wristbands", migration 0006).
//
//   - An athlete has a home account (who can see and edit them) and a slug made from the name,
//     unique across the site ("jordan-smith", then "jordan-smith-2").
//   - A wristband is one BLE beacon, identified by its BLE address, owned by the account that
//     enrolled it. It is active, lost or retired.
//   - An assignment gives a band to an athlete: permanent, or a loaner that expires. At most one
//     open assignment per band (a partial unique index). A loaner past its expiry still counts as
//     open until the band is returned or reassigned; presenting it resolves as "expired".
//   - A band presented to a controller checks its athlete in at that station until the next band
//     or Check out; presented to an account pod it is being enrolled (pod-protocol.md section 8).
const { knex, T, nowEpoch, insertId, isUniqueViolation } = require("../db/knex");
const { audit } = require("./audit");

const LOANS = { permanent: null, "1h": 3600, "12h": 43200, "24h": 86400, "5d": 432000 };
const LOAN_LABELS = { permanent: "Permanent", "1h": "Loaner, 1 hour", "12h": "Loaner, 12 hours", "24h": "Loaner, 24 hours", "5d": "Loaner, 5 days" };

function normalizeBand(mac)
{
    const m = String(mac || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    return m.length === 12 ? m : null;
}

function cleanName(name)
{
    const n = String(name || "").replace(/\s+/g, " ").trim();
    return n.length >= 1 && n.length <= 80 ? n : null;
}

function slugBase(name)
{
    const s = String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
    return s || "athlete";
}

function actorOf(user)
{
    return user ? { actorType: "user", actorId: user.id, actorName: user.username } : { actorType: "system" };
}

// Creates an athlete with the first free slug. Returns the row.
async function createAthlete(accountId, name, user, trxIn)
{
    const n = cleanName(name);
    if (!n) { throw new Error("A name of 1 to 80 characters is required."); }
    const base = slugBase(n);
    const run = async (trx) =>
    {
        const taken = new Set(await trx(T("athletes")).where("slug", base).orWhere("slug", "like", base + "-%").pluck("slug"));
        let slug = base;
        for (let i = 2; taken.has(slug); i++) { slug = base + "-" + i; }
        const ids = await trx(T("athletes")).insert({ account_id: accountId, display_name: n, slug: slug, created_epoch: nowEpoch(), created_by: user ? user.id : null }).returning("id");
        const row = await trx(T("athletes")).where({ id: insertId(ids) }).first();
        await audit(trx, Object.assign({ entityType: "athlete", entityUid: row.uid, entityName: n, field: "created", newValue: slug }, actorOf(user)));
        return row;
    };
    if (trxIn) { return run(trxIn); }
    // Two athletes with the same new name at once: the unique index refuses one; take the next slug.
    for (let attempt = 0; ; attempt++)
    {
        try { return await knex.transaction(run); }
        catch (err) { if (!isUniqueViolation(err) || attempt >= 3) { throw err; } }
    }
}

async function rename(athlete, name, user)
{
    const n = cleanName(name);
    if (!n) { return { ok: false, error: "A name of 1 to 80 characters is required." }; }
    if (n === athlete.display_name) { return { ok: true }; }
    await knex.transaction(async (trx) =>
    {
        await trx(T("athletes")).where({ id: athlete.id }).update({ display_name: n });
        await audit(trx, Object.assign({ entityType: "athlete", entityUid: athlete.uid, entityName: n, field: "display_name", oldValue: athlete.display_name, newValue: n }, actorOf(user)));
    });
    return { ok: true };
}

// Registers a band in an account. { ok, band } or { ok: false, error }.
async function addBand(accountId, bandMac, label, user, trxIn)
{
    const mac = normalizeBand(bandMac);
    if (!mac) { return { ok: false, error: "A band id is 12 hex digits (its BLE address)." }; }
    const run = async (trx) =>
    {
        const existing = await trx(T("wristbands")).where({ band_mac: mac }).first();
        if (existing) { return { ok: false, error: "That band is already registered" + (existing.account_id === accountId ? " here." : " to another account."), band: existing }; }
        const ids = await trx(T("wristbands")).insert({ band_mac: mac, label: label ? String(label).trim().slice(0, 40) || null : null, account_id: accountId, status: "active", created_epoch: nowEpoch(), created_by: user ? user.id : null }).returning("id");
        const band = await trx(T("wristbands")).where({ id: insertId(ids) }).first();
        await audit(trx, Object.assign({ entityType: "wristband", entityUid: band.uid, entityName: band.label || mac, field: "created", newValue: mac }, actorOf(user)));
        return { ok: true, band: band };
    };
    return trxIn ? run(trxIn) : knex.transaction(run);
}

function openAssignment(db, bandId)
{
    return db(T("wristband_assignments")).where({ wristband_id: bandId }).whereNull("closed_epoch").first();
}

async function closeAssignment(trx, a, reason, user, band)
{
    await trx(T("wristband_assignments")).where({ id: a.id }).update({ closed_epoch: nowEpoch(), closed_reason: reason });
    const athlete = await trx(T("athletes")).where({ id: a.athlete_id }).first();
    await audit(trx, Object.assign({ entityType: "wristband", entityUid: band.uid, entityName: band.label || band.band_mac, field: "athlete", oldValue: athlete ? athlete.display_name : null, newValue: null }, actorOf(user)));
}

// Gives a band to an athlete of the same account. loan: a LOANS key. { ok } or { ok: false, error }.
async function assign(band, athlete, loan, user, trxIn)
{
    if (!Object.prototype.hasOwnProperty.call(LOANS, loan)) { return { ok: false, error: "Choose permanent or a loaner length." }; }
    if (band.account_id !== athlete.account_id) { return { ok: false, error: "The band and the athlete belong to different accounts." }; }
    const run = async (trx) =>
    {
        const b = await trx(T("wristbands")).where({ id: band.id }).forUpdate().first();
        if (b.status !== "active") { return { ok: false, error: "That band is marked " + b.status + "." }; }
        const now = nowEpoch();
        const open = await openAssignment(trx, b.id);
        if (open)
        {
            const expired = open.expires_epoch !== null && open.expires_epoch <= now;
            if (!expired)
            {
                const holder = await trx(T("athletes")).where({ id: open.athlete_id }).first();
                return { ok: false, error: "That band is with " + (holder ? holder.display_name : "another athlete") + ". Return it first." };
            }
            await closeAssignment(trx, open, "expired", user, b);
        }
        const secs = LOANS[loan];
        await trx(T("wristband_assignments")).insert({ wristband_id: b.id, athlete_id: athlete.id, start_epoch: now, expires_epoch: secs === null ? null : now + secs, assigned_by: user ? user.id : null });
        await audit(trx, Object.assign({ entityType: "wristband", entityUid: b.uid, entityName: b.label || b.band_mac, field: "athlete", oldValue: null, newValue: athlete.display_name + (secs === null ? "" : " (" + LOAN_LABELS[loan] + ")") }, actorOf(user)));
        return { ok: true };
    };
    return trxIn ? run(trxIn) : knex.transaction(run);
}

// Back from its athlete (returned), or marked lost / retired / active again.
async function setStatus(band, status, user)
{
    if (!["active", "lost", "retired", "returned"].includes(status)) { return { ok: false, error: "Unknown status." }; }
    await knex.transaction(async (trx) =>
    {
        const b = await trx(T("wristbands")).where({ id: band.id }).forUpdate().first();
        const open = await openAssignment(trx, b.id);
        if (open && status !== "active") { await closeAssignment(trx, open, status, user, b); }
        if (status !== "returned" && status !== b.status)
        {
            await trx(T("wristbands")).where({ id: b.id }).update({ status: status });
            await audit(trx, Object.assign({ entityType: "wristband", entityUid: b.uid, entityName: b.label || b.band_mac, field: "status", oldValue: b.status, newValue: status }, actorOf(user)));
        }
    });
    return { ok: true };
}

async function relabel(band, label, user)
{
    const l = String(label || "").trim().slice(0, 40) || null;
    if (l === band.label) { return; }
    await knex.transaction(async (trx) =>
    {
        await trx(T("wristbands")).where({ id: band.id }).update({ label: l });
        await audit(trx, Object.assign({ entityType: "wristband", entityUid: band.uid, entityName: l || band.band_mac, field: "label", oldValue: band.label, newValue: l }, actorOf(user)));
    });
}

// What a band means right now: { outcome, band, athlete, assignment }.
//   checked_in  an active band with an open, unexpired assignment
//   expired     its loaner ran out            unassigned  registered, nobody has it
//   lost | retired                            unknown     never registered
async function resolve(bandMac, now)
{
    const t = now || nowEpoch();
    const band = await knex(T("wristbands")).where({ band_mac: bandMac }).first();
    if (!band) { return { outcome: "unknown", band: null, athlete: null, assignment: null }; }
    const a = await openAssignment(knex, band.id);
    const athlete = a ? await knex(T("athletes")).where({ id: a.athlete_id }).first() : null;
    if (band.status !== "active") { return { outcome: band.status, band: band, athlete: athlete, assignment: a || null }; }
    if (!a) { return { outcome: "unassigned", band: band, athlete: null, assignment: null }; }
    if (a.expires_epoch !== null && a.expires_epoch <= t) { return { outcome: "expired", band: band, athlete: athlete, assignment: a }; }
    return { outcome: "checked_in", band: band, athlete: athlete, assignment: a };
}

// From ingest: a band presented to a controller or account pod. On a controller it replaces the
// athlete checked in at that station. Returns the resolution.
async function present(pod, bandMac, rssi, epoch)
{
    const r = await resolve(bandMac, epoch);
    await knex.transaction(async (trx) =>
    {
        await trx(T("band_presentations")).where({ device_id: pod.id }).whereNull("checked_out_epoch").update({ checked_out_epoch: epoch });
        await trx(T("band_presentations")).insert(
        {
            device_id: pod.id, band_mac: bandMac, wristband_id: r.band ? r.band.id : null, athlete_id: r.athlete ? r.athlete.id : null,
            outcome: r.outcome, rssi: Number.isFinite(rssi) ? Math.round(rssi) : null, epoch: epoch
        });
    });
    return r;
}

// The pod's current band: the newest presentation not checked out, resolved as it stands now (so
// an enrollment or a rename shows at once). null when nobody is checked in.
async function current(podId)
{
    const p = await knex(T("band_presentations")).where({ device_id: podId }).whereNull("checked_out_epoch").orderBy("id", "desc").first();
    if (!p) { return null; }
    const r = await resolve(p.band_mac);
    const account = r.athlete ? await knex(T("accounts")).where({ id: r.athlete.account_id }).first() : null;
    return Object.assign({ presentation: p, athleteAccount: account || null }, r);
}

async function checkout(podId)
{
    return knex(T("band_presentations")).where({ device_id: podId }).whereNull("checked_out_epoch").update({ checked_out_epoch: nowEpoch() });
}

// Account pod enrollment: a band presented here that has no athlete gets a new athlete of the
// pod's account, registering the band first if it is new. { ok, athlete } or { ok: false, error }.
async function enroll(pod, accountId, bandMac, name, user)
{
    const mac = normalizeBand(bandMac);
    if (!mac) { return { ok: false, error: "No band." }; }
    const seen = await knex(T("band_presentations")).where({ device_id: pod.id, band_mac: mac }).first();
    if (!seen) { return { ok: false, error: "That band has not been presented to this pod." }; }
    if (!cleanName(name)) { return { ok: false, error: "A name of 1 to 80 characters is required." }; }
    return knex.transaction(async (trx) =>
    {
        let band = await trx(T("wristbands")).where({ band_mac: mac }).forUpdate().first();
        if (band && band.account_id !== accountId) { return { ok: false, error: "That band belongs to another account." }; }
        if (band && band.status !== "active") { return { ok: false, error: "That band is marked " + band.status + "." }; }
        if (band)
        {
            const open = await openAssignment(trx, band.id);
            if (open && (open.expires_epoch === null || open.expires_epoch > nowEpoch())) { return { ok: false, error: "That band already has an athlete." }; }
        }
        else
        {
            const added = await addBand(accountId, mac, null, user, trx);
            if (!added.ok) { return added; }
            band = added.band;
        }
        const athlete = await createAthlete(accountId, name, user, trx);
        const a = await assign(band, athlete, "permanent", user, trx);
        if (!a.ok) { throw new Error(a.error); }
        // The presentation that led here is the athlete's first appearance.
        const last = await trx(T("band_presentations")).where({ device_id: pod.id, band_mac: mac }).orderBy("id", "desc").first();
        await trx(T("band_presentations")).where({ id: last.id }).update({ athlete_id: athlete.id, wristband_id: band.id, outcome: "enrolled" });
        return { ok: true, athlete: athlete, band: band };
    });
}

// Page lists.
async function athletesForAccount(accountId)
{
    const rows = await knex(T("athletes")).where({ account_id: accountId }).orderBy("display_name");
    if (!rows.length) { return rows; }
    const ids = rows.map((r) => r.id);
    const bands = await knex(T("wristband_assignments") + " as a").join(T("wristbands") + " as w", "w.id", "a.wristband_id")
        .whereIn("a.athlete_id", ids).whereNull("a.closed_epoch").select("a.athlete_id", "a.expires_epoch", "w.band_mac", "w.label", "w.uid");
    const last = await knex(T("band_presentations")).whereIn("athlete_id", ids).groupBy("athlete_id").select("athlete_id").max("epoch as epoch");
    const lastBy = new Map(last.map((l) => [l.athlete_id, Number(l.epoch)]));
    rows.forEach((r) =>
    {
        r.bands = bands.filter((b) => b.athlete_id === r.id);
        r.last_seen = lastBy.get(r.id) || null;
    });
    return rows;
}

async function bandsForAccount(accountId)
{
    const rows = await knex(T("wristbands") + " as w")
        .leftJoin(T("wristband_assignments") + " as a", function () { this.on("a.wristband_id", "=", "w.id").andOnNull("a.closed_epoch"); })
        .leftJoin(T("athletes") + " as t", "t.id", "a.athlete_id")
        .where("w.account_id", accountId)
        .select("w.*", "a.expires_epoch", "a.start_epoch", "t.display_name as athlete_name", "t.uid as athlete_uid")
        .orderByRaw("w.label NULLS LAST, w.band_mac");
    if (!rows.length) { return rows; }
    const last = await knex(T("band_presentations")).whereIn("band_mac", rows.map((r) => r.band_mac)).groupBy("band_mac").select("band_mac").max("epoch as epoch");
    const lastBy = new Map(last.map((l) => [l.band_mac, Number(l.epoch)]));
    rows.forEach((r) => { r.last_seen = lastBy.get(r.band_mac) || null; });
    return rows;
}

async function athleteDetail(athlete)
{
    const assignments = await knex(T("wristband_assignments") + " as a").join(T("wristbands") + " as w", "w.id", "a.wristband_id")
        .where("a.athlete_id", athlete.id).select("a.*", "w.band_mac", "w.label", "w.uid as band_uid", "w.status as band_status")
        .orderByRaw("a.closed_epoch IS NOT NULL, a.start_epoch DESC").limit(50);
    const presentations = await knex(T("band_presentations") + " as p").join(T("devices") + " as d", "d.id", "p.device_id")
        .leftJoin(T("locations") + " as l", "l.id", "d.location_id")
        .where("p.athlete_id", athlete.id).select("p.epoch", "p.outcome", "p.band_mac", "d.name as pod_name", "d.uid as pod_uid", "l.name as location_name")
        .orderBy("p.id", "desc").limit(20);
    const free = await knex(T("wristbands") + " as w")
        .leftJoin(T("wristband_assignments") + " as a", function () { this.on("a.wristband_id", "=", "w.id").andOnNull("a.closed_epoch"); })
        .where({ "w.account_id": athlete.account_id, "w.status": "active" })
        .where(function () { this.whereNull("a.id").orWhere("a.expires_epoch", "<=", nowEpoch()); })
        .select("w.*").orderByRaw("w.label NULLS LAST, w.band_mac");
    return { assignments: assignments, presentations: presentations, freeBands: free };
}

module.exports =
{
    LOANS, LOAN_LABELS, normalizeBand, slugBase, cleanName, createAthlete, rename, addBand, assign, setStatus, relabel,
    resolve, present, current, checkout, enroll, athletesForAccount, bandsForAccount, athleteDetail
};
