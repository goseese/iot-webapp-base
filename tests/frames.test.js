const test = require("node:test");
const assert = require("node:assert");
const frames = require("../pipeline/frames");

function header(opts)
{
    const b = Buffer.alloc(frames.HEADER_LEN + (opts.body ? opts.body.length : 0));
    let o = 0;
    b.writeUInt8(opts.cmd || 1, o); o += 1;
    b.writeUInt8(opts.layout || 2, o); o += 1;
    b.writeUInt32LE(opts.counter || 42, o); o += 4;
    Buffer.from(opts.mac || "A4CF12345678", "hex").copy(b, o); o += 6;
    const model = opts.model || "ss-cfd";
    b.writeUInt8(model.length, o); o += 1;
    b.write(model, o, "ascii"); o += 9;
    b.writeUInt16LE(opts.fw || 0x0104, o); o += 2;
    b.writeUInt8(opts.frameType || 0, o); o += 1;
    if (opts.body) { opts.body.copy(b, o); }
    return b;
}

test("header parses fields and body offset", () =>
{
    const body = Buffer.alloc(6);
    body.writeInt16LE(-1234, 0);     // temp x100
    body.writeUInt16LE(5500, 2);     // humidity x100
    body.writeUInt16LE(3300, 4);     // mV
    const h = frames.parseHeader(header({ body: body }));
    assert.equal(h.mac, "A4CF12345678");
    assert.equal(h.model, "ss-cfd");
    assert.equal(h.counter, 42);
    assert.equal(h.firmware, "1.4");
    assert.equal(h.body.length, 6);

    const values = frames.parseFields(
    [
        { channel: "temp", type: "i16", offset: 0, scale: 0.01 },
        { channel: "humi", type: "u16", offset: 2, scale: 0.01 },
        { channel: "vbat", type: "u16", offset: 4 },
        { channel: "missing", type: "u32", offset: 4 }
    ], h);
    assert.deepEqual(values, { temp: -12.34, humi: 55, vbat: 3300 });
});

test("field list keyed by layout version", () =>
{
    const body = Buffer.from([7, 9]);
    const h = frames.parseHeader(header({ layout: 1, body: body }));
    const values = frames.parseFields({ 1: [{ channel: "a", type: "u8", offset: 0 }], 2: [{ channel: "b", type: "u8", offset: 1 }] }, h);
    assert.deepEqual(values, { a: 7 });
});

test("short frame rejected", () =>
{
    assert.equal(frames.parseHeader(Buffer.alloc(10)), null);
});
