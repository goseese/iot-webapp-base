// LoRa frame header (gateway-protocol 4.2) and the generic field list parser used by node
// device types. All packed structs are little endian (ESP32 and AVR).
const HEADER_LEN = 25;

function parseHeader(buf)
{
    if (buf.length < HEADER_LEN) { return null; }
    let o = 0;
    const cmd = buf.readUInt8(o); o += 1;
    const layout = buf.readUInt8(o); o += 1;
    const counter = buf.readUInt32LE(o); o += 4;
    const mac = buf.subarray(o, o + 6).toString("hex").toUpperCase(); o += 6;
    const modelLen = Math.min(buf.readUInt8(o), 9); o += 1;
    const model = buf.subarray(o, o + modelLen).toString("ascii").replace(/\0.*$/, ""); o += 9;
    const fwRaw = buf.readUInt16LE(o); o += 2;
    const frameType = buf.readUInt8(o); o += 1;
    return {
        cmd: cmd, layout: layout, counter: counter, mac: mac, model: model,
        firmware: (fwRaw >> 8) + "." + (fwRaw & 0xff), firmwareRaw: fwRaw,
        frameType: frameType, body: buf.subarray(o)
    };
}

const READERS =
{
    u8: (b, o) => b.readUInt8(o), i8: (b, o) => b.readInt8(o),
    u16: (b, o) => b.readUInt16LE(o), i16: (b, o) => b.readInt16LE(o),
    u32: (b, o) => b.readUInt32LE(o), i32: (b, o) => b.readInt32LE(o),
    f32: (b, o) => b.readFloatLE(o)
};
const SIZES = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };

// fields: [{ channel, type, offset, scale?, skipValue? }] relative to the body; a field list
// may be keyed by layout version: { 1: [...], 2: [...] }.
function parseFields(fieldsSpec, header)
{
    const fields = Array.isArray(fieldsSpec) ? fieldsSpec : (fieldsSpec[header.layout] || fieldsSpec[Object.keys(fieldsSpec).sort().pop()]);
    const values = {};
    for (const f of fields || [])
    {
        if (f.frameType !== undefined && f.frameType !== header.frameType) { continue; }
        if (header.body.length < f.offset + SIZES[f.type]) { continue; }
        let v = READERS[f.type](header.body, f.offset);
        if (f.skipValue !== undefined && v === f.skipValue) { continue; }
        if (f.scale) { v = v * f.scale; }
        values[f.channel] = v;
    }
    return values;
}

module.exports = { parseHeader, parseFields, HEADER_LEN };
