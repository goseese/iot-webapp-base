# API writes need apiWrite: port guide

Built and settled on voltastc (Oct 2026). This closes a gap where any API key with write
permission could post readings to any device, including gateways and radio nodes whose data should
only ever come from the radio. It is written to be handed to Claude (or a developer) working in
the target repo, as the spec for the work. The target is the devmon / DTM family of sites on
Windows and IIS.

## How to use this document

1. Read the target site's own decisions log, structure notes, `routes/api.js` and
   `deviceTypes/index.js` first. Where the site already settled something that conflicts with
   this guide, stop and ask; do not overwrite it.
2. Do the audit below before changing any code. It decides which types get the flag.
3. Agree a plan, then build in the order at the end, one step at a time, with review between steps.
4. Record the decision in the site's decisions log.

## The gap

The HTTP API has two write routes (names as on voltastc; map them to the target's):

- `POST /api/v1/devices/<uid>/readings`: readings for one device by channel. On voltastc it
  accepted any live, unarchived device kind.
- `POST /api/v1/readings`: single readings by sensor uid, limited to `direct` and `asset` devices.

Both hand the values to the pipeline at stage 2, exactly like a radio frame. So a key with API
write could post readings for a gateway or node and they would:

- update hot values and run alarm rules,
- move the device's `last_seen_epoch` forward, which can make an offline unit look online and hide
  a real no data alarm,
- be indistinguishable from radio data once stored (`readings` has no source column; only a null
  `gateway_id` hints at it).

Even the `direct` limit on `POST /readings` let a key post fake `platform_server` stats.

## The fix

A device type module may declare `apiWrite: true`. Absent means false. Only devices whose type
declares it take API readings.

1. **Type loader** (`deviceTypes/index.js` `validate()`): refuse any `apiWrite` value that is not
   true or false, so a typo fails at startup.

   ```js
   if (t.apiWrite !== undefined && typeof t.apiWrite !== "boolean")
   {
       throw new Error("device type " + t.slug + ": apiWrite must be true or false");
   }
   ```

2. **`POST /devices/<uid>/readings`**: after the device lookup and the API write permission check
   (which answers 404, so a key that may not write there learns nothing), and after the type is
   loaded:

   ```js
   if (!type.apiWrite) { return res.status(403).json({ error: "This device type does not accept API readings" }); }
   ```

   This is a capability refusal, not an access denial: the key can already see the device, so it
   is a real 403, not the not found reply.

3. **`POST /readings`**: keep the existing direct devices only check and add the flag check after
   it, rejecting that one item and carrying on (the route already reports partial success):

   ```js
   const tr = await knex(T("device_types")).where({ id: d.device_type_id }).first();
   if (!tr || !deviceTypes.get(tr.slug).apiWrite) { rejected.push({ index: i, error: "this device type does not accept API readings" }); continue; }
   ```

   Adjust to the site's query layer; on SQL Server sites `T()` adds the table prefix.

4. **API docs** (`services/apiDocs.js` if the site has it, else wherever the API is documented):
   say on both write endpoints that the device's type must accept API readings, add the 403 to the
   device readings note, and add a 403 row to the status table.

5. **Test** (`tests/deviceTypes.test.js`): every declared `apiWrite` is a boolean, and the set of
   types that turn it on matches an explicit `allowed` list in the test, so turning one on is a
   deliberate change.

## The audit (do this first on the target site)

voltastc had no type that legitimately takes API readings, so it shipped with the flag off
everywhere. The target site may have customers posting real data through the API today. Before
the change, find out which device types actually receive API readings:

- Search the event log or audit log for the API write actions (`api_readings`,
  `api_device_readings` on voltastc) over a long window, grouped by device and device type.
- Ask Jeff about any integration (a PLC, a customer script, a data logger) that posts by HTTP.

Every type that shows up gets `apiWrite: true` and goes in the test's `allowed` list in the same
change. Any type that shows up but should not (a gateway or radio node), list for Jeff before
deciding; do not silently cut off a customer.

## Status codes on IIS sites (always 200)

voltastc sends real HTTP status codes. The IIS sites do not: devmon's `middleware/httpStatus.js`
sends every reply as HTTP 200, with the real code in the `x-app-status` header and in the body,
because the customer's IIS replaces error bodies. That thread likely knows this already.

- Write the route the normal way, `res.status(403).json(...)`. Do not hand build a 200; the
  middleware does the rewrite. Confirm that the middleware covers the API router (check where it
  is mounted in `app.js` relative to `/api/v1`).
- To a caller, a refused write on IIS looks like HTTP 200 with `x-app-status: 403` and the error
  in the body. The API docs on those sites already explain this (`alwaysOk` true), so the new 403
  row in the status table reads correctly there.
- `POST /readings` is unaffected: a refused item is a line in `rejected`, and the request is
  200 (or 422 when nothing was accepted) as before.

## Settled alongside it

- **No override per device.** A per device setting to allow API writes was considered and
  rejected: a migration, a settings field, a permission and an audit for a rarely used switch, and
  it would mix API and radio data on one device.
- Data from a PLC or other outside system gets its own device type with `kind: "direct"` and
  `apiWrite: true`.
- Fake data for testing goes through the site's fake device script and the broker, not the API.

## Suggested order

1. Audit, and agree the list of types that keep API writes.
2. Type loader check (plus `apiWrite: true` on the agreed types).
3. Both API write routes.
4. API docs wording and status table.
5. Decisions log entry.
6. Test with the `allowed` list.

After deploy, check with a key that has API write: a post to a radio device's readings should come
back refused (HTTP 200 with `x-app-status: 403` on IIS, 403 elsewhere), and a post to an allowed
type should still be accepted.
