const test = require("node:test");
const assert = require("node:assert");
const apiDocs = require("../services/apiDocs");

// Site values given explicitly, so these run without config or a database.
function siteWith(prefix)
{
    return apiDocs.siteOf({ name: "Example", apiBase: "https://app.example.com/api/v1", keyPrefix: prefix, ratePerMinute: 120, maxObjects: 1000 });
}

test("the shell variable in examples comes from the key prefix", () =>
{
    assert.equal(apiDocs.envVarOf("example"), "EXAMPLE_KEY");
    assert.equal(apiDocs.envVarOf("volta.stc"), "VOLTA_STC_KEY");
    assert.equal(apiDocs.envVarOf("my-key~1"), "MY_KEY_1_KEY");
    assert.equal(apiDocs.envVarOf("9x"), "API_9X_KEY");
    assert.equal(apiDocs.envVarOf(null), "API_KEY");
    assert.equal(apiDocs.envVarOf(""), "API_KEY");
});

test("every endpoint example uses this site's base URL and shell variable", () =>
{
    for (const prefix of ["example", null])
    {
        const d = apiDocs.build(siteWith(prefix));
        assert.ok(d.endpoints.length >= 14);
        for (const e of d.endpoints)
        {
            assert.ok(e.example.includes(d.site.apiBase), e.id);
            assert.ok(e.example.includes("$" + d.site.envVar), e.id);
        }
        assert.ok(d.t.shell.includes("export " + d.site.envVar + "="));
    }
});

test("the Markdown file is well formed", () =>
{
    const md = apiDocs.markdown(siteWith("example"));
    assert.ok(md.startsWith("# Example API and webhooks\n"));
    assert.equal((md.match(/^```/gm) || []).length % 2, 0, "code fences balanced");
    const prose = md.split("```").filter((x, i) => i % 2 === 0).join("");
    assert.ok(!prose.includes("<uid>"), "no raw <uid> outside code");
    assert.ok(!/\]\(@/.test(md), "no account page links");
    assert.ok(!md.includes(String.fromCharCode(0x2014)), "no em dashes");
    for (const id of ["getting-a-key", "making-requests", "replies-and-errors", "permissions", "endpoints", "webhooks", "deliveries", "events", "checking-the-signature"])
    {
        assert.ok(md.includes("](#" + id + ")"), "contents link " + id);
    }
    for (const e of apiDocs.build(siteWith("example")).endpoints) { assert.ok(md.includes("<a id=\"" + e.id + "\"></a>"), "anchor " + e.id); }
    assert.ok(md.includes("[alarm endpoints](#alarm-detail)"), "API Docs anchors stay links inside the file");
});

test("the Markdown file states the blank prefix and says nothing about a viewer", () =>
{
    const md = apiDocs.markdown(siteWith(null));
    assert.ok(md.includes("API_KEY_PREFIX"));
    assert.ok(md.includes("$API_KEY"));
    assert.ok(!/\bthis account\b/.test(md), "generic: no 'this account'");
});

test("file name is the site name made safe", () =>
{
    assert.equal(apiDocs.fileName("Example"), "example-api.md");
    assert.equal(apiDocs.fileName("Acme IoT / Main"), "acme-iot-main-api.md");
    assert.equal(apiDocs.fileName(""), "site-api.md");
});

test("inline markup to HTML escapes first, then marks up", () =>
{
    assert.equal(apiDocs.html("Use `<b>` and **this** [tab](@/api) or [here](#x)", "/account/u"),
        "Use <code>&lt;b&gt;</code> and <strong>this</strong> <a href=\"/account/u/api\">tab</a> or <a href=\"#x\">here</a>");
});

// The API tabs (DECISIONS "API tabs"): every command uses the page's uids and this site's values, and
// writes show only where they apply.
test("page calls use the page's uids and offer writes only where allowed", () =>
{
    const s = siteWith("example");
    const check = (r, uid) =>
    {
        assert.ok(r.calls.length > 0);
        for (const c of r.calls)
        {
            assert.ok(c.example.includes(s.apiBase) && c.example.includes("$" + s.envVar), c.docs);
            assert.ok(c.method && c.path && c.perm && c.about, c.docs);
        }
        assert.ok(r.calls.some((c) => c.example.includes(uid)));
        assert.ok(r.intro.includes("$" + s.envVar));
    };
    const device = (apiWrite) => apiDocs.pageCalls(s, { kind: "device", device: { uid: "dev-1", apiWrite: apiWrite, channels: ["vin", "int-temp", "x"] }, sensors: [{ uid: "sen-1", name: "Power in" }, { uid: "sen-2", name: "Temp" }] });
    check(device(false), "dev-1");
    assert.ok(!device(false).calls.some((c) => c.method === "POST"), "no POST without apiWrite");
    const w = device(true).calls.find((c) => c.method === "POST");
    assert.ok(w && w.example.includes("/devices/dev-1/readings") && w.about.includes("vin, int-temp, x"));
    const readings = device(false).calls.find((c) => c.docs === "readings");
    assert.ok(readings.example.includes("sensor=sen-1") && readings.example.includes("sensor=sen-2") && readings.example.includes("# Power in"));

    const sensor = (apiWrite, rules) => apiDocs.pageCalls(s, { kind: "sensor", sensor: { uid: "sen-1", channel: "vin" }, device: { uid: "dev-1", apiWrite: apiWrite }, rules: rules });
    check(sensor(false, []), "sen-1");
    assert.ok(!sensor(false, []).calls.some((c) => c.docs === "rule-changes" || c.method === "POST"));
    assert.ok(sensor(false, [{ uid: "rule-1", label: "lower, alarm" }]).calls.find((c) => c.docs === "rule-changes").example.includes("rule=rule-1"));
    assert.ok(sensor(true, []).calls.find((c) => c.method === "POST").example.includes("{\"data\":{\"vin\":0}}"));

    const loc = apiDocs.pageCalls(s, { kind: "location-alarms", location: { uid: "loc-1" }, account: { uid: "acc-1" } });
    check(loc, "loc-1");
    assert.ok(loc.calls.some((c) => c.example.includes("account=acc-1")));
    assert.ok(loc.calls.some((c) => c.example.includes("/devices/silent?location=loc-1&minutes=1440")));
    assert.ok(!apiDocs.pageCalls(s, { kind: "location-alarms", location: { uid: "loc-1" }, account: null }).calls.some((c) => c.example.includes("account=")));
    const devs = apiDocs.pageCalls(s, { kind: "location-devices", location: { uid: "loc-1" } });
    check(devs, "loc-1");
    assert.deepEqual(devs.calls.map((c) => c.docs), ["devices", "silent-devices"]);

    check(apiDocs.pageCalls(s, { kind: "alarm", alarm: { uid: "alm-1", active: true } }), "alm-1");
    assert.deepEqual(apiDocs.pageCalls(s, { kind: "alarm", alarm: { uid: "alm-1", active: true } }).calls.map((c) => c.docs), ["alarm-detail", "ack", "clear"]);
    assert.deepEqual(apiDocs.pageCalls(s, { kind: "alarm", alarm: { uid: "alm-1", active: false } }).calls.map((c) => c.docs), ["alarm-detail"]);
});
