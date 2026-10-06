// Support requests (DECISIONS.md "Support requests"): the pure helpers in services/support.js.
const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x";
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY || "0".repeat(64);
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_NAME = process.env.DB_NAME || "x";
process.env.DB_USER = process.env.DB_USER || "x";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "x";
const s = require("../services/support");

test("the reference is YYYYMMDD-HHMMSS in UTC", () =>
{
    assert.equal(s.makeRef(1790000000), "20260921-141320");
    assert.equal(s.makeRef(0), "19700101-000000");
    assert.equal(s.makeRef(1790000000).length, 15);
});

test("addresses split on commas, semicolons and spaces; bad ones reported; duplicates dropped", () =>
{
    const r = s.parseAddresses(" a@x.com; B@y.org,b@y.org  c@z.io\nnot-an-address ");
    assert.deepEqual(r.list, ["a@x.com", "B@y.org", "c@z.io"]);
    assert.deepEqual(r.bad, ["not-an-address"]);
    assert.deepEqual(s.parseAddresses("").list, []);
});

test("the page is kept only as a path on this site", () =>
{
    assert.deepEqual(s.cleanPage("/locations/abc/devices?x=1", "Acme / Devices"), { url: "/locations/abc/devices?x=1", title: "Acme / Devices" });
    assert.equal(s.cleanPage("https://evil.example/x", "t").url, null);
    assert.equal(s.cleanPage("//evil.example/x", "t").url, null);
    assert.equal(s.cleanPage("/\\evil", "t").url, null);
    assert.equal(s.cleanPage("javascript:alert(1)", "t").url, null);
    assert.equal(s.cleanPage("/a b", "t").url, null);
    assert.equal(s.cleanPage("/" + "a".repeat(2048), "t").url, null);
});

test("file types come from the extension allowlist", () =>
{
    assert.equal(s.fileType("Report.PDF"), "application/pdf");
    assert.equal(s.fileType("photo.jpeg"), "image/jpeg");
    assert.equal(s.fileType("run.log"), "text/plain");
    assert.equal(s.fileType("page.html"), null);
    assert.equal(s.fileType("image.svg"), null);
    assert.equal(s.fileType("noextension"), null);
    assert.ok(s.isInline("image/png"));
    assert.ok(!s.isInline("image/heic"));
    assert.ok(!s.isInline("application/pdf"));
});

test("file names lose paths, control characters and quotes", () =>
{
    assert.equal(s.cleanFilename("C:\\Users\\jeff\\log \"1\".txt"), "log 1.txt");
    assert.equal(s.cleanFilename("../../etc/passwd"), "passwd");
    assert.equal(s.cleanFilename(""), "file");
    assert.equal(s.cleanFilename("a".repeat(300) + ".txt").length, 255);
});

test("severities: unknown keys fall back to issue", () =>
{
    assert.equal(s.severityOf("urgent").prefix, "[URGENT]");
    assert.equal(s.severityOf("nonsense").key, "issue");
    assert.deepEqual(s.SEVERITIES.map((x) => x.key), ["production-down", "urgent", "issue", "feature-request"]);
});

test("subject and key block in the agreed format", () =>
{
    const r = { severity: "issue", ref: "20261006-033028", display_name: "Jeff", username: "jeff", email: "jeff@example.com", account_name: "Corporate Mobile Housing", location_name: null };
    assert.equal(s.subjectFor(r, "from " + s.nameOf(r)), "[ISSUE] Support request 20261006-033028 from Jeff (jeff), Corporate Mobile Housing");
    assert.equal(s.keyBlock(r),
        "Account: Corporate Mobile Housing\n" +
        "Location: Not specified\n" +
        "User: Jeff (jeff), jeff@example.com\n" +
        "Severity: Needs a look, not urgent\n" +
        "Reference: 20261006-033028\n");
    const none = Object.assign({}, r, { account_name: null, display_name: null });
    assert.equal(s.subjectFor(none, "from " + s.nameOf(none)), "[ISSUE] Support request 20261006-033028 from jeff");
});

test("list filters: unknown keys fall back to open and answered", () =>
{
    assert.equal(s.filterOf("closed").key, "closed");
    assert.equal(s.filterOf("bogus").key, "active");
    assert.deepEqual(s.filterOf("active").statuses, ["open", "answered"]);
    assert.equal(s.filterOf("all").statuses, null);
});
