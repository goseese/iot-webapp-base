const test = require("node:test");
const assert = require("node:assert");
const apiDocs = require("../services/apiDocs");

// Site values given explicitly, so these run without config or a database.
function siteWith(prefix)
{
    return apiDocs.siteOf({ name: "Voltastc", apiBase: "https://app.example.com/api/v1", keyPrefix: prefix, ratePerMinute: 120, maxObjects: 1000 });
}

test("the shell variable in examples comes from the key prefix", () =>
{
    assert.equal(apiDocs.envVarOf("voltastc"), "VOLTASTC_KEY");
    assert.equal(apiDocs.envVarOf("volta.stc"), "VOLTA_STC_KEY");
    assert.equal(apiDocs.envVarOf("my-key~1"), "MY_KEY_1_KEY");
    assert.equal(apiDocs.envVarOf("9x"), "API_9X_KEY");
    assert.equal(apiDocs.envVarOf(null), "API_KEY");
    assert.equal(apiDocs.envVarOf(""), "API_KEY");
});

test("every endpoint example uses this site's base URL and shell variable", () =>
{
    for (const prefix of ["voltastc", null])
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
    const md = apiDocs.markdown(siteWith("voltastc"));
    assert.ok(md.startsWith("# Voltastc API and webhooks\n"));
    assert.equal((md.match(/^```/gm) || []).length % 2, 0, "code fences balanced");
    const prose = md.split("```").filter((x, i) => i % 2 === 0).join("");
    assert.ok(!prose.includes("<uid>"), "no raw <uid> outside code");
    assert.ok(!/\]\(@/.test(md), "no account page links");
    assert.ok(!md.includes(String.fromCharCode(0x2014)), "no em dashes");
    for (const id of ["getting-a-key", "making-requests", "replies-and-errors", "permissions", "endpoints", "webhooks", "deliveries", "events", "checking-the-signature"])
    {
        assert.ok(md.includes("](#" + id + ")"), "contents link " + id);
    }
    for (const e of apiDocs.build(siteWith("voltastc")).endpoints) { assert.ok(md.includes("<a id=\"" + e.id + "\"></a>"), "anchor " + e.id); }
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
    assert.equal(apiDocs.fileName("Voltastc"), "voltastc-api.md");
    assert.equal(apiDocs.fileName("Volta STC / Main"), "volta-stc-main-api.md");
    assert.equal(apiDocs.fileName(""), "site-api.md");
});

test("inline markup to HTML escapes first, then marks up", () =>
{
    assert.equal(apiDocs.html("Use `<b>` and **this** [tab](@/api) or [here](#x)", "/account/u"),
        "Use <code>&lt;b&gt;</code> and <strong>this</strong> <a href=\"/account/u/api\">tab</a> or <a href=\"#x\">here</a>");
});
