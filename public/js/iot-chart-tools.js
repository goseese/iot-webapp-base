/* Chart tools for every chart panel, at the bottom left under the chart:
   - Download: the raw readings inside the zoom window as CSV or JSON.
   - Share: email it from the user's own mail program (image and data attached), copy a link to
     this exact view, or download a PNG of it.
   - The view in the URL: range (a preset) or from and to pick the data, start and end the zoom
     window, all whole epoch seconds. One chart per page owns the URL.
   The page's chart script supplies its data; files are written by iot-table-tools.js
   (window.iotExport), the same way table downloads are. */
(function ()
{
    // The visible window in ms. The x axis is pinned to [from, to], so the dataZoom percentages are
    // of that span (checked in ECharts 6.1.0: adding older points keeps the window on the same times).
    function visibleWindow(chart, from, to)
    {
        var z = (chart.getOption().dataZoom || [])[1];
        var start = z && isFinite(z.start) ? z.start : 0;
        var end = z && isFinite(z.end) ? z.end : 100;
        return [from + (to - from) * start / 100, from + (to - from) * end / 100];
    }
    function isZoomed(chart)
    {
        var z = (chart.getOption().dataZoom || [])[1] || {};
        return z.start > 0.01 || z.end < 99.99;
    }

    // "2026-10-06 22:25:13" in the given IANA timezone (the browser's when none). sv-SE gives this
    // order and a 24 hour clock, which sorts and opens cleanly in a spreadsheet.
    var formats = {};
    function localTime(ms, tz)
    {
        var key = tz || "";
        if (!formats[key])
        {
            var o = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
            if (tz) { o.timeZone = tz; }
            formats[key] = new Intl.DateTimeFormat("sv-SE", o);
        }
        return formats[key].format(new Date(ms));
    }

    function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
    function stamp(ms) { return localTime(ms).slice(0, 16).replace(/[ :]/g, "-"); }
    function titles(container)
    {
        var title = document.querySelector(".iot-page-title");
        var panel = container.closest(".iot-panel");
        var head = panel ? panel.querySelector(".iot-panel__header strong") : null;
        return { page: title ? title.textContent.trim() : "", panel: head ? head.textContent.trim() : "" };
    }
    // page title, panel title, window start and end
    function fileName(container, from, to)
    {
        var t = titles(container);
        return [slug(t.page) || "chart", slug(t.panel), stamp(from), "to", stamp(to)].filter(Boolean).join("-");
    }

    // ---- the view in the URL

    // range is a preset name; from, to, start and end are whole epoch seconds or null (the server
    // checks from and to again).
    function urlState()
    {
        var q = new URLSearchParams(location.search);
        function sec(k)
        {
            var v = q.get(k);
            if (v === null || v === "") { return null; }
            var n = Math.floor(Number(v));
            return isFinite(n) && n >= 0 ? n : null;
        }
        return { range: q.get("range"), from: sec("from"), to: sec("to"), start: sec("start"), end: sec("end") };
    }

    // Merges changes into the query string (null removes a key), keeping other keys such as a
    // dashboard's tab, without a new history entry.
    function setUrl(changes)
    {
        var q = new URLSearchParams(location.search);
        Object.keys(changes).forEach(function (k)
        {
            if (changes[k] === null || changes[k] === undefined) { q.delete(k); }
            else { q.set(k, String(changes[k])); }
        });
        var s = q.toString();
        history.replaceState(history.state, "", location.pathname + (s ? "?" + s : "") + location.hash);
    }

    // start and end (epoch seconds) as dataZoom percentages of [from, to] (ms), or null for the whole span.
    function zoomPct(from, to, start, end)
    {
        if (start === null || end === null || !(to > from) || !(end > start)) { return null; }
        var clamp = function (x) { return Math.max(0, Math.min(100, x)); };
        return { start: clamp((start * 1000 - from) / (to - from) * 100), end: clamp((end * 1000 - from) / (to - from) * 100) };
    }

    // Writes the zoom window to the URL as start and end a moment after the user stops zooming;
    // zooming back out to the whole span removes them. getSpan() returns { from, to } in ms.
    function trackZoom(chart, getSpan)
    {
        var timer = null;
        chart.on("datazoom", function ()
        {
            clearTimeout(timer);
            timer = setTimeout(function ()
            {
                var s = getSpan();
                if (!s) { return; }
                if (!isZoomed(chart)) { setUrl({ start: null, end: null }); return; }
                var w = visibleWindow(chart, s.from, s.to);
                setUrl({ start: Math.floor(w[0] / 1000), end: Math.ceil(w[1] / 1000) });
            }, 400);
        });
    }

    // ---- Download

    // Puts the control first in container. getData() returns { headers, rows, from, to, partial }:
    // from and to (ms) name the file; partial, when set, is a sentence saying the file is incomplete.
    function addDownload(container, getData)
    {
        var wrap = document.createElement("div");
        wrap.className = "dropup iot-chart-dl";
        wrap.innerHTML = '<button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" title="Download the readings in view"><i class="fa-solid fa-download me-1"></i>Download</button>' +
            '<ul class="dropdown-menu"><li><a class="dropdown-item" href="#" data-dl="csv">Download CSV</a></li><li><a class="dropdown-item" href="#" data-dl="json">Download JSON</a></li></ul>';
        container.insertBefore(wrap, container.firstChild);
        wrap.addEventListener("click", function (e)
        {
            var a = e.target.closest("[data-dl]");
            if (!a) { return; }
            e.preventDefault();
            var d = getData();
            if (!d || !d.rows.length)
            {
                if (window.iotFlash) { iotFlash("warning", "No readings in view to download."); }
                return;
            }
            var name = fileName(container, d.from, d.to);
            if (a.dataset.dl === "csv") { iotExport.download(name + ".csv", iotExport.toCsv(d.headers, d.rows), "text/csv"); }
            else { iotExport.download(name + ".json", iotExport.toJson(d.headers, d.rows), "application/json"); }
            if (d.partial && window.iotFlash) { iotFlash("warning", d.partial); }
        });
    }

    // ---- Share

    // A fixed window: from and to of the loaded range plus the zoom, so the link shows the same
    // readings whenever it is opened. Other keys (a dashboard's tab) are kept.
    function viewLink(chart, s)
    {
        var q = new URLSearchParams(location.search);
        q.delete("range");
        q.set("from", String(Math.floor(s.from / 1000)));
        q.set("to", String(Math.ceil(s.to / 1000)));
        if (isZoomed(chart))
        {
            var w = visibleWindow(chart, s.from, s.to);
            q.set("start", String(Math.floor(w[0] / 1000)));
            q.set("end", String(Math.ceil(w[1] / 1000)));
        }
        else { q.delete("start"); q.delete("end"); }
        return location.origin + location.pathname + "?" + q.toString();
    }

    // The chart as drawn, at twice its size, on the panel color, with the page and panel titles and
    // the window (in tz, the browser's when null) above it, so it reads on its own in an email.
    function pngBlob(chart, container, s, tz)
    {
        return new Promise(function (resolve)
        {
            var css = getComputedStyle(document.documentElement);
            var bg = css.getPropertyValue("--iot-panel").trim() || "#ffffff";
            var fg = css.getPropertyValue("--iot-text").trim() || "#000000";
            var muted = css.getPropertyValue("--iot-text-muted").trim() || fg;
            var zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
            var ratio = 2;
            var img = new Image();
            img.onload = function ()
            {
                var t = titles(container);
                var w = visibleWindow(chart, s.from, s.to);
                var head = 56 * ratio;
                var c = document.createElement("canvas");
                c.width = img.width;
                c.height = img.height + head;
                var g = c.getContext("2d");
                g.fillStyle = bg;
                g.fillRect(0, 0, c.width, c.height);
                g.fillStyle = fg;
                g.font = "600 " + (16 * ratio) + "px system-ui, sans-serif";
                g.fillText([t.page, t.panel].filter(Boolean).join(" / "), 16 * ratio, 24 * ratio);
                g.fillStyle = muted;
                g.font = (12 * ratio) + "px system-ui, sans-serif";
                g.fillText(localTime(w[0], zone) + " to " + localTime(w[1], zone) + " (" + zone + ")", 16 * ratio, 44 * ratio);
                g.drawImage(img, 0, head);
                c.toBlob(function (blob) { resolve(blob); }, "image/png");
            };
            img.src = chart.getDataURL({ type: "png", pixelRatio: ratio, backgroundColor: bg });
        });
    }
    function saveBlob(blob, name)
    {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
    function png(chart, container, s, tz)
    {
        var w = visibleWindow(chart, s.from, s.to);
        pngBlob(chart, container, s, tz).then(function (blob) { saveBlob(blob, fileName(container, w[0], w[1]) + ".png"); });
    }

    // ---- a one file zip: deflate from the browser's CompressionStream, CRC-32 here

    var crcTable = null;
    function crc32(bytes)
    {
        if (!crcTable)
        {
            crcTable = new Uint32Array(256);
            for (var n = 0; n < 256; n++)
            {
                var c = n;
                for (var k = 0; k < 8; k++) { c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; }
                crcTable[n] = c >>> 0;
            }
        }
        var crc = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) { crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8); }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function canZip() { return typeof CompressionStream === "function"; }
    // Local header, deflated data, central directory, end record (PKWARE APPNOTE 4.3), UTF-8 name.
    async function zipOne(name, text)
    {
        var data = new TextEncoder().encode(text);
        var packed = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
        var fname = new TextEncoder().encode(name);
        var crc = crc32(data);
        var d = new Date();
        var time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
        var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        var local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 8, true);
        local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
        local.setUint32(18, packed.length, true); local.setUint32(22, data.length, true); local.setUint16(26, fname.length, true); local.setUint16(28, 0, true);
        var central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x0800, true); central.setUint16(10, 8, true);
        central.setUint16(12, time, true); central.setUint16(14, date, true); central.setUint32(16, crc, true);
        central.setUint32(20, packed.length, true); central.setUint32(24, data.length, true); central.setUint16(28, fname.length, true);
        var end = new DataView(new ArrayBuffer(22));
        var cdOffset = 30 + fname.length + packed.length;
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
        end.setUint32(12, 46 + fname.length, true); end.setUint32(16, cdOffset, true);
        return new Blob([local, fname, packed, central, fname, end], { type: "application/zip" });
    }

    // ---- Email: the user's own mail program, through the system share sheet (Web Share with files)

    // The tokens a name can use: the alarm title ones that fit a chart (services/alarms/title.js
    // TOKEN_HELP) plus chart_name and window. Rendered by iot-title.js like an alarm title field.
    var NAME_TOKENS =
    [
        ["chart_name", "Chart name"], ["window", "Time window in view"], ["site_name", "Site name"], ["account_name", "Account name"],
        ["location_name", "Location name"], ["device_name", "Device name"], ["sensor_name", "Sensor name"]
    ];
    function renderName(template, vars)
    {
        return String(template).replace(/\{([a-z_]+)\}/g, function (whole, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] === null || vars[k] === undefined ? "" : vars[k]) : whole; }).replace(/\s+/g, " ").trim();
    }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    // Whether the share sheet takes files at all (asked with a PNG). It cannot tell which data formats
    // will be refused: Chrome's canShare() does not check file types (navigator_share.cc); the type
    // list is checked later and share() fails with "Permission denied" (share_service_impl.cc: png and
    // csv yes, json and zip no). So only CSV is ever attached; the other formats go the download way.
    function shareTakes(name, type)
    {
        try { return !!(navigator.canShare && navigator.canShare({ files: [new File(["x"], name, { type: type })] })); }
        catch (e) { return false; }
    }
    var FORMATS =
    [
        { key: "csv", label: "CSV", ext: ".csv", type: "text/csv" },
        { key: "json", label: "JSON", ext: ".json", type: "application/json" },
        { key: "csvzip", label: "CSV in a .zip", ext: ".csv.zip", type: "application/zip", zip: true },
        { key: "jsonzip", label: "JSON in a .zip", ext: ".json.zip", type: "application/zip", zip: true }
    ];

    var emailSeq = 0;
    function emailDialog(container, o)
    {
        var id = "iotChartEmail" + (++emailSeq);
        var m = document.createElement("div");
        m.className = "modal fade";
        m.id = id;
        m.tabIndex = -1;
        m.innerHTML =
            '<div class="modal-dialog"><div class="modal-content">' +
            '<div class="modal-header"><h5 class="modal-title">Email this chart</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
            '<div class="modal-body">' +
              '<div class="mb-3" data-title-field data-title-prefix="none" data-sample="{}">' +
                '<label class="form-label" for="' + id + 'Name">Name</label>' +
                '<div class="input-group"><input class="form-control" id="' + id + 'Name" maxlength="200" autocomplete="off" data-title-input>' +
                '<button class="btn btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" data-bs-auto-close="outside" data-bs-popper-config=\'{"strategy":"fixed"}\' aria-expanded="false" title="Insert a token at the cursor">Tokens</button>' +
                '<ul class="dropdown-menu dropdown-menu-end" style="max-height: 22rem; overflow-y: auto;">' +
                NAME_TOKENS.map(function (t) { return '<li><button type="button" class="dropdown-item py-1" data-title-token="' + t[0] + '"><code>{' + t[0] + '}</code><span class="d-block small text-secondary">' + t[1] + '</span></button></li>'; }).join("") +
                '</ul></div>' +
                '<div class="form-text text-break">Preview: <span style="color: var(--iot-text)" data-title-preview></span></div>' +
                '<div class="form-text text-warning d-none" data-title-unknown></div>' +
              '</div>' +
              '<div class="mb-3"><label class="form-label" for="' + id + 'Comment">Comment</label><textarea class="form-control" id="' + id + 'Comment" rows="4" maxlength="4000"></textarea></div>' +
              '<div class="mb-2"><label class="form-label" for="' + id + 'Format">Data file</label><select class="form-select" id="' + id + 'Format"></select></div>' +
              '<div class="form-text" data-email-about></div>' +
              '<div class="form-text text-warning d-none" data-email-fallback>This browser cannot attach files to an email. Download the image and the data, then open the email and attach them.</div>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>' +
              '<button type="button" class="btn btn-outline-secondary d-none" data-email="png"><i class="fa-solid fa-download me-1"></i>Image</button>' +
              '<button type="button" class="btn btn-outline-secondary d-none" data-email="data"><i class="fa-solid fa-download me-1"></i>Data</button>' +
              '<button type="button" class="btn btn-primary" data-email="send" disabled>Preparing...</button>' +
            '</div>' +
            '</div></div>';
        document.body.appendChild(m);

        var nameIn = m.querySelector("[data-title-input]"), field = m.querySelector("[data-title-field]");
        var comment = m.querySelector("textarea"), format = m.querySelector("select");
        var send = m.querySelector('[data-email="send"]'), about = m.querySelector("[data-email-about]"), fallbackNote = m.querySelector("[data-email-fallback]");
        var state = null;   // what the dialog was opened on: { s, d, vars, link, png, data, share }
        var prepId = 0;

        function body()
        {
            var lines = [renderName(nameIn.value || o.nameTemplate, state.vars)];
            if (comment.value.trim()) { lines.push("", comment.value.trim()); }
            lines.push("", "View this chart on " + (state.vars.site_name || "the site") + " (sign in needed):", state.link);
            lines.push("", "Attached: the chart image and " + state.d.rows.length.toLocaleString() + " readings" + (state.data ? " (" + state.data.name + ")" : "") + ".");
            if (state.d.partial) { lines.push(state.d.partial); }
            return lines.join("\n");
        }

        // Builds the image and the data file once per opening (and per format change), so the
        // Email button can call navigator.share straight from the click: browsers only allow it
        // during the click's user activation.
        async function prepare()
        {
            var my = ++prepId;
            var f = FORMATS.filter(function (x) { return x.key === format.value; })[0];
            state.share = state.shareAvail && f.key === "csv";
            fallbackNote.textContent = state.shareAvail
                ? "Only CSV can be attached through the share sheet. Download the image and the data, then open the email and attach them, or choose CSV to attach both directly."
                : "This browser cannot attach files to an email. Download the image and the data, then open the email and attach them.";
            fallbackNote.classList.toggle("d-none", state.share);
            m.querySelectorAll('[data-email="png"], [data-email="data"]').forEach(function (b) { b.classList.toggle("d-none", state.share); });
            send.disabled = true;
            send.textContent = "Preparing...";
            var base = fileName(container, state.w[0], state.w[1]);
            var inner = f.key.indexOf("json") === 0 ? iotExport.toJson(state.d.headers, state.d.rows) : iotExport.toCsv(state.d.headers, state.d.rows);
            var dataBlob = f.zip ? await zipOne(base + f.ext.replace(".zip", ""), inner) : new Blob([inner], { type: f.type });
            var image = state.png || await pngBlob(o.chart, container, state.s, o.getTimezone ? o.getTimezone() : null);
            if (my !== prepId) { return; }
            state.png = image;
            state.data = new File([dataBlob], base + f.ext, { type: f.type });
            state.image = new File([image], base + ".png", { type: "image/png" });
            send.disabled = false;
            send.textContent = state.share ? "Email..." : "Open email";
        }

        format.addEventListener("change", prepare);
        m.querySelector('[data-email="png"]').addEventListener("click", function () { if (state && state.image) { saveBlob(state.image, state.image.name); } });
        m.querySelector('[data-email="data"]').addEventListener("click", function () { if (state && state.data) { saveBlob(state.data, state.data.name); } });
        send.addEventListener("click", function ()
        {
            if (!state || !state.data) { return; }
            var subject = renderName(nameIn.value || o.nameTemplate, state.vars);
            if (state.share)
            {
                navigator.share({ files: [state.image, state.data], title: subject, text: body() }).then(function ()
                {
                    bootstrap.Modal.getOrCreateInstance(m).hide();
                }, function (err)
                {
                    if (err && err.name === "AbortError") { return; }   // the user closed the share sheet
                    if (window.iotFlash) { iotFlash("danger", "Could not open the share sheet: " + (err && err.message ? err.message : err)); }
                });
            }
            else
            {
                var a = document.createElement("a");
                a.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body());
                document.body.appendChild(a); a.click(); a.remove();
            }
        });

        return function open()
        {
            var s = o.getSpan();
            var d = s ? o.getData() : null;
            if (!d || !d.rows.length)
            {
                if (window.iotFlash) { iotFlash("warning", "No readings in view to email."); }
                return;
            }
            var w = visibleWindow(o.chart, s.from, s.to);
            var tz = o.getTimezone ? o.getTimezone() : null;
            var vars = Object.assign({}, o.getVars ? o.getVars() : {}, { window: localTime(w[0], tz).slice(0, 16) + " to " + localTime(w[1], tz).slice(0, 16) });
            var shareAvail = !!navigator.share && shareTakes("chart.png", "image/png");
            state = { s: s, d: d, w: w, vars: vars, link: viewLink(o.chart, s), shareAvail: shareAvail, share: false, png: null, data: null, image: null };
            field.dataset.sample = JSON.stringify(vars);
            if (!nameIn.value) { nameIn.value = o.nameTemplate; }
            nameIn.dispatchEvent(new Event("input", { bubbles: true }));
            // Formats this browser can build (zip needs CompressionStream); only CSV is attached.
            var keep = format.value;
            format.innerHTML = FORMATS.map(function (f)
            {
                var ok = !f.zip || canZip();
                return '<option value="' + f.key + '"' + (ok ? "" : " disabled") + '>' + esc(f.label) + (ok || !f.zip ? "" : " (not in this browser)") + (shareAvail && f.key !== "csv" ? " (download, then attach)" : "") + '</option>';
            }).join("");
            format.value = keep && !format.querySelector('option[value="' + keep + '"]').disabled ? keep : "csv";
            about.textContent = "Attaches the chart image and the " + d.rows.length.toLocaleString() + " readings in view. The link opens this view for people who can sign in to " + (vars.site_name || "the site") + ".";
            bootstrap.Modal.getOrCreateInstance(m).show();
            prepare();
        };
    }

    // Puts the control after Download. o: { chart, getSpan() the chart's { from, to } in ms,
    // getTimezone() IANA name or null for the browser's, getData() as for Download, getVars() the
    // token values, nameTemplate the default Name }.
    function addShare(container, o)
    {
        var wrap = document.createElement("div");
        wrap.className = "dropup iot-chart-share";
        wrap.innerHTML = '<button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" title="Share this view"><i class="fa-solid fa-share-nodes me-1"></i>Share</button>' +
            '<ul class="dropdown-menu"><li><a class="dropdown-item" href="#" data-share="email">Email...</a></li><li><a class="dropdown-item" href="#" data-share="link">Copy link to this view</a></li><li><a class="dropdown-item" href="#" data-share="png">Download PNG</a></li></ul>';
        var dl = container.querySelector(".iot-chart-dl");
        container.insertBefore(wrap, dl ? dl.nextSibling : container.firstChild);
        var openEmail = null;
        wrap.addEventListener("click", function (e)
        {
            var a = e.target.closest("[data-share]");
            if (!a) { return; }
            e.preventDefault();
            var s = o.getSpan();
            if (!s) { return; }
            if (a.dataset.share === "email")
            {
                if (!openEmail) { openEmail = emailDialog(container, o); }
                openEmail();
            }
            else if (a.dataset.share === "link") { iotExport.copy(viewLink(o.chart, s), "a link to this view"); }
            else { png(o.chart, container, s, o.getTimezone ? o.getTimezone() : null); }
        });
    }

    window.iotChartTools = { visibleWindow: visibleWindow, localTime: localTime, urlState: urlState, setUrl: setUrl, zoomPct: zoomPct, trackZoom: trackZoom, addDownload: addDownload, addShare: addShare, viewLink: viewLink };
})();
