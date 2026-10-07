// Pure helpers for chart email sent from the site (services/chartEmail.js), with no database or
// settings, so tests/chartEmailHelpers.test.js runs anywhere.
const zlib = require("zlib");

const MAX_RECIPIENTS = 5;
// The same address check as support requests (services/support.js ADDRESS_RE).
const ADDRESS_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A full link, or anything that would load from elsewhere: a scheme with // (http://, https://,
// ftp://), a protocol relative //host, www., or a javascript:, vbscript:, file: or data: target.
// A bare name such as maintenance.com is allowed (Jeff, Oct 2026).
function hasLink(text)
{
    const s = String(text || "");
    return /[a-z][a-z0-9+.-]*:\/\//i.test(s) || /(^|[\s("'<])\/\/[^\s\/]/.test(s) || /\bwww\./i.test(s) ||
        /\b(javascript|vbscript|file):\S/i.test(s) || /\bdata:[a-z]+\//i.test(s);
}

// Control characters out (line breaks kept), trimmed, cut to max.
function cleanText(v, max)
{
    return String(v === undefined || v === null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

// Comma, semicolon, space or new line separated; duplicates dropped. { list, error }.
function parseRecipients(value)
{
    const list = [], bad = [], seen = new Set();
    for (const part of String(value || "").split(/[,;\s]+/))
    {
        const a = part.trim();
        if (!a) { continue; }
        if (a.length > 254 || !ADDRESS_RE.test(a)) { bad.push(a); continue; }
        if (seen.has(a.toLowerCase())) { continue; }
        seen.add(a.toLowerCase());
        list.push(a);
    }
    if (bad.length) { return { list: [], error: "Not an email address: " + bad.slice(0, 3).join(", ") + "." }; }
    if (!list.length) { return { list: [], error: "Add at least one address to send to." }; }
    if (list.length > MAX_RECIPIENTS) { return { list: [], error: "At most " + MAX_RECIPIENTS + " recipients per email. Send another email for the rest." }; }
    return { list: list, error: null };
}

function isPng(buf) { return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE); }

function validTz(tz)
{
    if (!tz || typeof tz !== "string" || tz.length > 64) { return false; }
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; }
    catch (e) { return false; }
}
function tzOf(tz) { return validTz(tz) ? tz : "UTC"; }

// "2026-10-06 22:25:13" in tz (the downloads' format, iot-chart-tools.js localTime()).
function localTime(epoch, tz)
{
    return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(epoch * 1000));
}

// Whole epoch seconds, as routes/api.js epochOf().
function epochOf(v)
{
    if (v === undefined || v === null || v === "") { return null; }
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 && n < 1e11 ? n : null;
}

// The same files as the browser downloads (iot-table-tools.js toCsv / toJson).
function toCsv(headers, rows)
{
    const esc = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [headers.map(esc).join(",")].concat(rows.map((r) => r.map(esc).join(","))).join("\r\n") + "\r\n";
}
function toJson(headers, rows)
{
    return JSON.stringify(rows.map((r) => { const o = {}; headers.forEach((h, i) => { o[h] = r[i] === undefined ? "" : r[i]; }); return o; }), null, 2);
}

// One file zip (PKWARE APPNOTE 4.3): deflate and CRC-32 from Node's zlib, UTF-8 name.
function zipOne(name, data)
{
    const packed = zlib.deflateRawSync(data);
    const fname = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fname.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fname.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + fname.length, 12); end.writeUInt32LE(30 + fname.length + packed.length, 16);
    return Buffer.concat([local, fname, packed, central, fname, end]);
}

function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart"; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

module.exports = { MAX_RECIPIENTS, hasLink, cleanText, parseRecipients, isPng, validTz, tzOf, localTime, epochOf, toCsv, toJson, zipOne, slug, esc };
