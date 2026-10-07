const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const h = require("../services/chartEmailHelpers");

test("hasLink refuses full links and remote loads, allows a bare name", () =>
{
    for (const s of ["see http://maintenance.com/", "HTTPS://x.y/p.png", "www.evil.com", "//cdn.x.com/pixel.gif", "javascript:alert(1)", "data:image/png;base64,AAA", "ftp://h/f"])
    {
        assert.strictEqual(h.hasLink(s), true, s);
    }
    for (const s of ["lets show this to maintenance.com guys", "and/or // comment", "data: see attached", "file.csv attached", "mailto:a@b.com", ""])
    {
        assert.strictEqual(h.hasLink(s), false, s);
    }
});

test("parseRecipients splits, dedupes and caps at 5", () =>
{
    assert.deepStrictEqual(h.parseRecipients("a@x.com, b@y.org\nA@x.com;c@z.io").list, ["a@x.com", "b@y.org", "c@z.io"]);
    assert.match(h.parseRecipients("a@x.com,nope").error, /Not an email address: nope/);
    assert.match(h.parseRecipients("  ").error, /at least one/);
    assert.match(h.parseRecipients("a@a.co b@a.co c@a.co d@a.co e@a.co f@a.co").error, /At most 5/);
    assert.strictEqual(h.parseRecipients("a@a.co b@a.co c@a.co d@a.co e@a.co").list.length, 5);
});

test("cleanText drops control characters and keeps line breaks", () =>
{
    assert.strictEqual(h.cleanText(" a\u0000b\r\nc ", 10), "ab\nc");
    assert.strictEqual(h.cleanText("abcdef", 3), "abc");
});

test("zipOne writes one entry a zip reader can inflate", () =>
{
    const data = Buffer.from("a,b\r\n1,2\r\n".repeat(500));
    const z = h.zipOne("data.csv", data);
    assert.strictEqual(z.readUInt32LE(0), 0x04034b50);
    const nameLen = z.readUInt16LE(26), size = z.readUInt32LE(18);
    assert.strictEqual(z.subarray(30, 30 + nameLen).toString(), "data.csv");
    assert.deepStrictEqual(zlib.inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + size)), data);
    assert.strictEqual(z.readUInt32LE(14), zlib.crc32(data) >>> 0);
    assert.strictEqual(z.readUInt32LE(z.length - 22), 0x06054b50);
});

test("toCsv quotes like the browser download, tz and time format", () =>
{
    assert.strictEqual(h.toCsv(["A", "B"], [["x,y", 1]]), "A,B\r\n\"x,y\",1\r\n");
    assert.strictEqual(h.localTime(1791295200, "America/Chicago"), "2026-10-06 09:00:00");
    assert.strictEqual(h.tzOf("Bad/Zone"), "UTC");
    assert.strictEqual(h.isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), true);
    assert.strictEqual(h.isPng(Buffer.from("GIF89a....")), false);
});
