// Device firmware downloads (services/firmware.js, command-protocol.md section 3).
//
// Unauthenticated on purpose: a gateway downloads over plain HTTPS GET, for itself or to pass on to
// the nodes behind it, and has no login to present. Only the images a device type names
// are served, from storage/firmware/{image}/firmware.bin. Mounted in app.js ahead of the session.
//
// The firmware needs Content-Length (arduino-esp32 HTTPUpdate refuses a response without it), so
// the file is sent whole, never chunked. x-MD5 is the header HTTPUpdate checks the image against.
const express = require("express");
const firmware = require("../services/firmware");
const { notFoundError } = require("../middleware/errors");

const router = express.Router();

router.get("/:image/" + firmware.FILE, async (req, res, next) =>
{
    try
    {
        const fw = await firmware.current(req.params.image);
        if (!fw) { return next(notFoundError()); }
        res.sendFile(firmware.filePath(fw.image),
        {
            headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "x-MD5": fw.md5 },
            lastModified: false,
            etag: false
        }, (err) => { if (err && !res.headersSent) { next(err); } });
    }
    catch (err) { next(err); }
});

module.exports = router;
