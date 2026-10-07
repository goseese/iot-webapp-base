const test = require("node:test");
const assert = require("node:assert");
const types = require("../deviceTypes");

test("platform_server declares valid channels", () =>
{
    const t = types.get("platform_server");
    assert.equal(t.kind, "direct");
    assert.ok(t.channels.some((c) => c.id === "http_response_ms"));
    const ids = t.channels.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
});

// DECISIONS "API writes need apiWrite": no type takes API readings today. Turning one on is a
// decision: add the type's slug here and update the DECISIONS entry in the same change.
test("apiWrite is a boolean when declared and no type turns it on", () =>
{
    const allowed = [];
    for (const t of Object.values(types.all))
    {
        assert.ok(t.apiWrite === undefined || typeof t.apiWrite === "boolean", t.slug + ": apiWrite must be true or false");
        assert.equal(Boolean(t.apiWrite), allowed.includes(t.slug), t.slug + ": apiWrite does not match the allowed list");
    }
});
