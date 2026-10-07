/* Chart tools: a Download control (CSV / JSON) at the bottom left of a chart panel, for the raw
   readings inside the chart's current zoom window. The page's chart script supplies the rows;
   files are written by iot-table-tools.js (window.iotExport), the same way table downloads are. */
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
            var title = document.querySelector(".iot-page-title");
            var panel = container.closest(".iot-panel");
            var head = panel ? panel.querySelector(".iot-panel__header strong") : null;
            var name = [slug(title ? title.textContent : "chart"), slug(head ? head.textContent : ""), stamp(d.from), "to", stamp(d.to)].filter(Boolean).join("-");
            if (a.dataset.dl === "csv") { iotExport.download(name + ".csv", iotExport.toCsv(d.headers, d.rows), "text/csv"); }
            else { iotExport.download(name + ".json", iotExport.toJson(d.headers, d.rows), "application/json"); }
            if (d.partial && window.iotFlash) { iotFlash("warning", d.partial); }
        });
    }

    window.iotChartTools = { visibleWindow: visibleWindow, localTime: localTime, addDownload: addDownload };
})();
