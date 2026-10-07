/* One sensor's chart on a page: the loader the sensor page and the alarm page share (Jeff, Oct 2026:
   one copy). Readings come from /sensors/<uid>/data newest first in chunks, drawn by
   iot-sensor-chart.js (bands, thresholds, alarm markers), with live points, Download, Share and the
   zoom in the URL from iot-chart-tools.js. The page passes what it has:
     iotSensorView.mount({
       chartEl, foot, note,      the chart div, the footer the tools go in, the note under the chart
       sensor, precision,        the sensor uid and the display precision
       range,                    the preset to load when the URL names no window (sensor page)
       rangeGroup,               the element holding the [data-range] buttons; adds Custom (sensor page)
       fitButton,                the Fit to data toggle (sensor page)
       loadMore,                 true for Load 30 more days (sensor page)
       window                    { from, to } epoch seconds when the URL names no window; to null is
                                 from then up to now, live (alarm page)
     })
   The view from the URL wins: from and to (a shared link, Custom with a To) fix the window and stop
   live points; from alone (Custom without a To, Load 30 more days) runs from then up to now; start
   and end zoom the first draw. Range buttons go back to the latest readings. */
(function ()
{
    var MAX_POINTS = 100000;   // per series; past this the note says how far back the chart goes

    function mount(o)
    {
        var chart = echarts.init(o.chartEl, null, { renderer: "canvas" });
        var current = null;   // last loaded data, so live points can be appended in place
        var base = "/sensors/" + o.sensor + "/data?";
        var ranges = o.rangeGroup ? Array.prototype.slice.call(o.rangeGroup.querySelectorAll("[data-range]")) : [];
        var view = iotChartTools.urlState();
        var fixed = view.from !== null && view.to !== null && view.to > view.from ? { from: view.from, to: view.to } : null;
        var since = view.from !== null && view.to === null ? view.from : null;
        if (!fixed && since === null && o.window)
        {
            if (o.window.to === null || o.window.to === undefined) { since = o.window.from; }
            else { fixed = { from: o.window.from, to: o.window.to }; }
        }
        var firstZoom = { start: view.start, end: view.end };
        window.devmonChart =
        {
            sensor: o.sensor,
            append: function (t, v)
            {
                if (!current || fixed) { return; }
                current.points.push([t, v]);
                while (since === null && current.points.length && current.points[0][0] < t - (current.to - current.from)) { current.points.shift(); }
                current.to = t;
                chart.setOption({ xAxis: { max: t }, series: [{ data: current.points }] });
            },
            // A live alarm change on this sensor (live.js, from the acct/ feed): its marker shows without
            // a reload. e: { uid, epoch, event_kind, severity }, as the /data route's alarm events. A
            // fixed window that ended before it leaves it out (alarmMarkers keeps only the window).
            alarm: function (e)
            {
                if (!current) { return; }
                current.alarms = mergeAlarms([e], current.alarms || []);
                draw(true);
            }
        };
        // Bands, thresholds, axis bounds and the option itself come from iot-sensor-chart.js, which
        // the alarm email image also uses, so the two charts cannot drift apart.
        var css = getComputedStyle(document.documentElement);
        var colors = iotSensorChart.themeColors(function (name) { return css.getPropertyValue(name).trim(); });
        var fit = false;   // "Fit to data" toggle: leave thresholds out of the y axis bounds

        // initial: the zoom to start with, as percentages, when not keeping the current one.
        function draw(keepZoom, initial)
        {
            var d = current;
            var zoom = initial || { start: 0, end: 100 };
            if (keepZoom)
            {
                var z = (chart.getOption().dataZoom || [])[1];
                if (z) { zoom = { start: z.start, end: z.end }; }
            }
            if (o.fitButton) { o.fitButton.classList.toggle("d-none", !d.rules.length); }
            chart.setOption(iotSensorChart.option(d, { colors: colors, precision: o.precision, fit: fit, zoom: zoom, timeText: function (ms) { return iotChartTools.localTime(ms, d.timezone).slice(0, 16); } }), true);
        }
        // Readings arrive newest first in chunks: the newest chunk draws at once, older chunks load
        // behind it and are added on the left, keeping the zoom window where it is. Clicking another
        // range starts a new load and the older one stops at its next chunk.
        var loadId = 0;
        var complete = false;   // every reading in the range is loaded (no more chunks, ceiling not hit)
        function showNote(text)
        {
            o.note.textContent = text || "";
            o.note.classList.toggle("d-none", !text);
        }
        async function load(range)
        {
            var id = ++loadId;
            complete = false;
            showNote("");
            if (more) { more.disabled = true; }
            // alarms=1: the alarm marker events for the whole window come with the first chunk only.
            var res = await fetch(base + "alarms=1&" + (fixed ? "from=" + fixed.from + "&to=" + fixed.to : since !== null ? "from=" + since : "range=" + range));
            if (!res.ok) { showNote("Could not load readings."); return; }
            var d = await res.json();
            if (id !== loadId) { return; }
            current = d;
            draw(false, iotChartTools.zoomPct(current.from, current.to, firstZoom.start, firstZoom.end));
            firstZoom = { start: null, end: null };
            while (d.more && current.points.length < MAX_POINTS)
            {
                showNote("Loading older readings...");
                res = await fetch(base + (range ? "range=" + range + "&" : "") + "from=" + Math.floor(current.from / 1000) + "&to=" + d.next_to);
                if (!res.ok) { showNote("Could not load older readings."); return; }
                d = await res.json();
                if (id !== loadId) { return; }
                current.points = d.points.concat(current.points);
                draw(true);
            }
            complete = !d.more;
            if (d.more)
            {
                showNote("Showing the newest " + current.points.length.toLocaleString() + " readings, back to " + new Date(current.points[0][0]).toLocaleString(undefined, { timeZone: current.timezone }) + ". Older readings in this range are not loaded.");
            }
            else { showNote(fixed && ranges.length ? "Fixed window: " + iotChartTools.localTime(current.from, current.timezone) + " to " + iotChartTools.localTime(current.to, current.timezone) + ". Click a range for the latest readings." : ""); }
            moreState();
        }

        // Load 30 more days: the 30 days before the oldest shown (at most a year in all), fetched
        // newest first in chunks and added on the left; the zoom window stays on the same times. The
        // URL keeps the new from (with to for a fixed window, else from alone: up to now, live).
        var more = null;   // the Load 30 more days button
        function moreState()
        {
            if (!more) { return; }
            var full = current && current.points.length >= MAX_POINTS;
            var can = current && !full && iotChartTools.moreFrom(current.from, current.to) !== null;
            more.disabled = !can;
            more.title = can ? "Load the 30 days before the oldest day shown" : full ? "The chart holds as many readings as it can (" + MAX_POINTS.toLocaleString() + ")." : "A chart window is at most a year.";
        }
        // Alarm events from an older window added to those already loaded: an alarm spanning both
        // windows comes back in both, so duplicates are dropped and the list stays oldest first.
        function mergeAlarms(older, loaded)
        {
            var seen = {}, out = [];
            older.concat(loaded).forEach(function (e)
            {
                var k = e.uid + "|" + e.epoch + "|" + e.event_kind + "|" + e.severity;
                if (!seen[k]) { seen[k] = true; out.push(e); }
            });
            return out.sort(function (a, b) { return a.epoch - b.epoch; });
        }
        async function loadMore()
        {
            if (!current) { return; }
            var newFrom = iotChartTools.moreFrom(current.from, current.to);
            if (newFrom === null || current.points.length >= MAX_POINTS) { return; }
            var id = ++loadId;
            var keep = iotChartTools.isZoomed(chart) ? iotChartTools.visibleWindow(chart, current.from, current.to) : null;
            var zoomTo = function () { return keep ? iotChartTools.zoomPct(current.from, current.to, keep[0] / 1000, keep[1] / 1000) : null; };
            var oldFrom = Math.floor(current.from / 1000), fromSec = Math.ceil(newFrom / 1000);
            var to = oldFrom - 1, added = 0, d = { more: true };
            more.disabled = true;
            showNote("Loading older readings...");
            current.from = fromSec * 1000;
            draw(false, zoomTo());
            while (d.more && current.points.length < MAX_POINTS)
            {
                var first = !added && to === oldFrom - 1;
                var res = await fetch(base + "from=" + fromSec + "&to=" + to + (first ? "&alarms=1" : ""));
                if (!res.ok) { showNote("Could not load older readings."); moreState(); return; }
                d = await res.json();
                if (id !== loadId) { return; }
                if (d.alarms) { current.alarms = mergeAlarms(d.alarms, current.alarms || []); }
                current.points = d.points.concat(current.points);
                added += d.points.length;
                to = d.next_to;
                draw(false, zoomTo());
            }
            complete = complete && !d.more;
            if (fixed) { fixed.from = fromSec; iotChartTools.setUrl({ from: fromSec }); }
            else
            {
                since = fromSec;
                iotChartTools.setUrl({ range: null, from: fromSec, to: null });
                ranges.forEach(function (x) { x.classList.remove("active"); });
                if (custom) { custom.classList.add("active"); }
            }
            if (d.more) { showNote("Showing the newest " + current.points.length.toLocaleString() + " readings, back to " + iotChartTools.localTime(current.points[0][0], current.timezone) + ". Older readings in this range are not loaded."); }
            else if (!added) { showNote("No readings from " + iotChartTools.localTime(fromSec * 1000, current.timezone) + " to " + iotChartTools.localTime(oldFrom * 1000, current.timezone) + "."); }
            else { showNote(""); }
            moreState();
        }

        // Custom: From and To in the location's timezone; To blank runs up to now, live.
        var custom = null;
        function applyCustom(fromSec, toSec)
        {
            ranges.forEach(function (x) { x.classList.remove("active"); });
            custom.classList.add("active");
            firstZoom = { start: null, end: null };
            if (toSec === null) { fixed = null; since = fromSec; }
            else { fixed = { from: fromSec, to: toSec }; since = null; }
            iotChartTools.setUrl({ range: null, from: fromSec, to: toSec, start: null, end: null });
            load(o.range);
        }
        if (o.fitButton)
        {
            o.fitButton.addEventListener("click", function ()
            {
                fit = !fit;
                o.fitButton.classList.toggle("active", fit);
                o.fitButton.setAttribute("aria-pressed", String(fit));
                if (current) { draw(true); }
            });
        }
        ranges.forEach(function (b)
        {
            b.addEventListener("click", function () { ranges.forEach(function (x) { x.classList.remove("active"); }); b.classList.add("active"); custom.classList.remove("active"); fixed = null; since = null; firstZoom = { start: null, end: null }; iotChartTools.setUrl({ range: b.dataset.range, from: null, to: null, start: null, end: null }); load(b.dataset.range); });
        });
        window.addEventListener("resize", function () { chart.resize(); });
        // Download: the raw readings inside the zoom window, in the location's timezone and display unit.
        var dataInView = function ()
        {
            if (!current) { return null; }
            var w = iotChartTools.visibleWindow(chart, current.from, current.to);
            var rows = current.points.filter(function (p) { return p[0] >= w[0] && p[0] <= w[1]; }).map(function (p) { return [iotChartTools.localTime(p[0], current.timezone), Math.round(p[0] / 1000), p[1], current.unit]; });
            var oldest = current.points.length ? current.points[0][0] : current.to;
            var partial = !complete && w[0] < oldest ? "Readings before " + iotChartTools.localTime(oldest, current.timezone) + " are not loaded, so the file starts there." : null;
            return { headers: ["Time (" + current.timezone + ")", "Epoch", "Value", "Unit"], rows: rows, from: w[0], to: w[1], partial: partial };
        };
        var foot = o.foot;
        iotChartTools.addDownload(foot, dataInView);
        // Share: email it (image and data attached), a link to this exact view, or a PNG of it; the
        // zoom window follows the URL as it changes.
        iotChartTools.addShare(foot, { chart: chart, getSpan: function () { return current; }, getTimezone: function () { return current ? current.timezone : null; }, getData: dataInView, getVars: function () { return JSON.parse(foot.dataset.chartVars); }, nameTemplate: "{sensor_name} on {device_name}, {window}", emailUrl: "/sensors/" + o.sensor + "/email", csrf: foot.dataset.csrf, siteName: JSON.parse(foot.dataset.chartVars).site_name });
        iotChartTools.trackZoom(chart, function () { return current; });
        if (ranges.length)
        {
            custom = iotChartTools.addCustomRange({ group: o.rangeGroup, getTimezone: function () { return current ? current.timezone : null; }, getSpan: function () { return current; }, isLive: function () { return !fixed; }, onApply: applyCustom });
        }
        if (o.loadMore) { more = iotChartTools.addLoadMore(foot, loadMore); }
        if (custom && (fixed || since !== null))
        {
            ranges.forEach(function (x) { x.classList.remove("active"); });
            custom.classList.add("active");
        }
        load(o.range);
        return { chart: chart };
    }

    window.iotSensorView = { mount: mount };
})();
