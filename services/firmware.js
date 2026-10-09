// Device firmware files (DECISIONS.md "Firmware updates", command-protocol.md section 3).
//
// One current file per firmware image, uploaded on Administration > Firmware (or copied in by hand):
//   storage/firmware/{image}/firmware.bin
// A device type names its image in firmwareImage; types that share firmware share an image.
//
// No version in the file name or URL: the server reads the file's MD5 when an ota command is
// queued and puts it in the command, so a device only installs the exact file that was chosen. A
// file replaced after that fails the device's MD5 check and it keeps its current firmware.
//
// Administration > Firmware uploads a file (store()): checked to be an ESP32-S3 app image, written
// beside the current one and renamed over it, so a device part way through a download finishes the old
// file. firmware.json beside it holds the version typed at upload, who and when, and the file's MD5;
// a file copied in by hand does not match that MD5, and its version shows as unknown.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const env = require("../config/env");

const DIR = path.join(__dirname, "..", "storage", "firmware");
const FILE = "firmware.bin";
const META = "firmware.json";
const MAX_BYTES = 4 * 1024 * 1024;     // nginx allows 8 MB on /admin/firmware/ (deploy/nginx)

// ESP-IDF app image layout (esp_app_format.h, esp_app_desc.h): a 24 byte image header (magic 0xE9 at
// byte 0, chip_id uint16 at byte 12), an 8 byte segment header, then esp_app_desc_t at byte 32
// (magic word 0xABCD5432, compile time at byte 112, date at byte 128, 16 bytes each).
const IMAGE_MAGIC = 0xE9;
const CHIP_ESP32S3 = 9;
const APP_DESC_MAGIC = 0xABCD5432;

// MD5 by image, kept while the file's size and modification time are unchanged.
const cache = new Map();

// Every image a device type names. Only these are served.
function images()
{
    const all = require("../deviceTypes").all;
    return [...new Set(Object.values(all).map((t) => t.firmwareImage).filter(Boolean))];
}

function filePath(image)
{
    if (!images().includes(image)) { return null; }
    return path.join(DIR, image, FILE);
}

function url(image)
{
    return new URL("/firmware/" + image + "/" + FILE, env.appUrl).toString();
}

function md5Of(file)
{
    return new Promise((resolve, reject) =>
    {
        const h = crypto.createHash("md5");
        fs.createReadStream(file).on("error", reject).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex")));
    });
}

// The image's current file: { image, url, md5, bytes, mtime_epoch }, or null when there is none.
async function current(image)
{
    const file = filePath(image);
    if (!file) { return null; }
    let st;
    try { st = await fs.promises.stat(file); }
    catch (err) { return null; }
    if (!st.isFile() || st.size === 0) { return null; }
    const hit = cache.get(image);
    let md5 = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.md5 : null;
    if (!md5)
    {
        md5 = await md5Of(file);
        cache.set(image, { size: st.size, mtimeMs: st.mtimeMs, md5: md5 });
    }
    return { image: image, url: url(image), md5: md5, bytes: st.size, mtime_epoch: Math.floor(st.mtimeMs / 1000) };
}

// The device types that install each image, for the admin page: [{ image, types: [display names] }].
function forPage()
{
    const all = Object.values(require("../deviceTypes").all);
    return images().map((image) => ({ image: image, types: all.filter((t) => t.firmwareImage === image).map((t) => t.displayName) }));
}

function cString(buf, start, len)
{
    const b = buf.subarray(start, start + len);
    const end = b.indexOf(0);
    return b.subarray(0, end < 0 ? b.length : end).toString("latin1");
}

// Checks an upload is an ESP32-S3 app image. { ok, error?, built? } (built: compile date and time).
function inspect(buf)
{
    if (buf.length < 256 || buf[0] !== IMAGE_MAGIC || buf.readUInt32LE(32) !== APP_DESC_MAGIC)
    {
        return { ok: false, error: "That is not an ESP32 app image. Upload the sketch's .ino.bin, not the bootloader, merged, partitions or .elf file." };
    }
    const chip = buf.readUInt16LE(12);
    if (chip !== CHIP_ESP32S3) { return { ok: false, error: "That image is built for another chip (chip id " + chip + "), not the ESP32-S3." }; }
    return { ok: true, built: (cString(buf, 128, 16) + " " + cString(buf, 112, 16)).trim() };
}

// Whether the version typed at upload appears in the file as a C string (the sketch's
// DEVICE_VERSION). Only a warning when it does not.
function hasVersion(buf, version)
{
    return buf.indexOf(Buffer.from("\0" + version + "\0", "latin1")) >= 0;
}

async function readMeta(image)
{
    try { return JSON.parse(await fs.promises.readFile(path.join(DIR, image, META), "utf8")); }
    catch (err) { return null; }
}

// current() plus what firmware.json says about it, when it describes this file: version, built,
// uploaded_epoch, uploaded_by, original_name. byHand: a file with no matching firmware.json.
async function describe(image)
{
    const fw = await current(image);
    if (!fw) { return null; }
    const meta = await readMeta(image);
    if (meta && meta.md5 === fw.md5) { return Object.assign(fw, { version: meta.version, built: meta.built || null, uploaded_epoch: meta.uploaded_epoch, uploaded_by: meta.uploaded_by, original_name: meta.original_name, byHand: false }); }
    return Object.assign(fw, { version: null, built: null, uploaded_epoch: null, uploaded_by: null, original_name: null, byHand: true });
}

async function writeAtomic(file, data)
{
    const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
    await fs.promises.writeFile(tmp, data, { mode: 0o640 });
    await fs.promises.rename(tmp, file);
}

// Makes buf the image's current file. The caller has checked it (inspect).
async function store(image, buf, meta)
{
    const dir = path.join(DIR, image);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 });
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    await writeAtomic(path.join(dir, FILE), buf);
    await writeAtomic(path.join(dir, META), JSON.stringify(Object.assign({ md5: md5, bytes: buf.length }, meta), null, 2) + "\n");
    cache.delete(image);
    return md5;
}

// The image a device type installs, or null.
function imageForType(typeModule)
{
    return typeModule && typeModule.firmwareImage ? typeModule.firmwareImage : null;
}

module.exports = { DIR, FILE, MAX_BYTES, images, filePath, url, current, describe, forPage, inspect, hasVersion, store, imageForType };
