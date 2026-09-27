// Pod firmware files (DECISIONS.md "Firmware updates", pod-protocol.md 5.4 ota).
//
// One current file per firmware image, copied onto the server by hand (sftp, then sudo install):
//   storage/firmware/{image}/firmware.bin
// The image names are the firmware sketches: volta-pod-ctl (controller and account pods) and
// volta-pod-target (both target pod models). A pod type names its image in firmwareImage.
//
// No version in the file name or URL: the server reads the file's MD5 when an ota command is
// queued and puts it in the command, so a pod only installs the exact file that was chosen. A file
// replaced after that fails the pod's MD5 check and the pod keeps its current firmware.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const env = require("../config/env");

const DIR = path.join(__dirname, "..", "storage", "firmware");
const FILE = "firmware.bin";

// MD5 by image, kept while the file's size and modification time are unchanged.
const cache = new Map();

// Every image a pod type names. Only these are served.
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

// The image a device type installs, or null.
function imageForType(typeModule)
{
    return typeModule && typeModule.firmwareImage ? typeModule.firmwareImage : null;
}

module.exports = { DIR, FILE, images, filePath, url, current, imageForType };
