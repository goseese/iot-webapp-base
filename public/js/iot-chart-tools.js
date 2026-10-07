/* Chart tools for every chart panel, at the bottom left under the chart:
   - Download: the raw readings inside the zoom window as CSV or JSON.
   - Share: copy a link to this exact view, or download a PNG of it.
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
    function png(chart, container, s, tz)
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
            c.toBlob(function (blob)
            {
                var a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = fileName(container, w[0], w[1]) + ".png";
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
            }, "image/png");
        };
        img.src = chart.getDataURL({ type: "png", pixelRatio: ratio, backgroundColor: bg });
    }

    // Puts the control after Download. getSpan() returns the chart's { from, to } in ms;
    // getTimezone() the IANA name for the PNG caption, or null for the browser's.
    function addShare(container, chart, getSpan, getTimezone)
    {
        var wrap = document.createElement("div");
        wrap.className = "dropup iot-chart-share";
        wrap.innerHTML = '<button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" title="Share this view"><i class="fa-solid fa-share-nodes me-1"></i>Share</button>' +
            '<ul class="dropdown-menu"><li><a class="dropdown-item" href="#" data-share="link">Copy link to this view</a></li><li><a class="dropdown-item" href="#" data-share="png">Download PNG</a></li></ul>';
        var dl = container.querySelector(".iot-chart-dl");
        container.insertBefore(wrap, dl ? dl.nextSibling : container.firstChild);
        wrap.addEventListener("click", function (e)
        {
            var a = e.target.closest("[data-share]");
            if (!a) { return; }
            e.preventDefault();
            var s = getSpan();
            if (!s) { return; }
            if (a.dataset.share === "link") { iotExport.copy(viewLink(chart, s), "a link to this view"); }
            else { png(chart, container, s, getTimezone ? getTimezone() : null); }
        });
    }

    window.iotChartTools = { visibleWindow: visibleWindow, localTime: localTime, urlState: urlState, setUrl: setUrl, zoomPct: zoomPct, trackZoom: trackZoom, addDownload: addDownload, addShare: addShare, viewLink: viewLink };
})();
