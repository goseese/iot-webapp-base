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

test("gw7080 provisions by its model string as a gateway", () =>
{
    const t = types.forModel("gw7080");
    assert.ok(t, "no type lists model gw7080");
    assert.equal(t.slug, "gw7080");
    assert.equal(t.kind, "gateway");
});
