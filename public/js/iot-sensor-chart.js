/* Sensor chart drawing shared by the browser and the server, so the two cannot drift apart.
   - views/sensors/show.ejs loads it with a script tag (window.iotSensorChart) and draws on canvas.
   - The alarm email image (services/alarms/chartImage.js, to come) will require() the same file.
   Pure functions only: no DOM, no fetch. Colors come in as the object themeColors() builds from the
   --iot-* variables in public/css/iot-theme.css (getComputedStyle in the browser, the file itself
   on the server). */
(function (root)
{
    var SEV_ALPHA = { info: 0.08, warning: 0.10, alarm: 0.12, emergency: 0.20 };

    // get(name) answers one CSS variable, such as get("--iot-danger") -> "#e05252".
    function themeColors(get)
    {
        return {
            primary: get("--iot-primary"), danger: get("--iot-danger"), warning: get("--iot-warning"), info: get("--iot-info"),
            text: get("--iot-text"), textMuted: get("--iot-text-muted"), border: get("--iot-border"), panel: get("--iot-panel")
        };
    }

    function sevColor(colors, severity)
    {
        var map = { info: colors.info, warning: colors.warning, alarm: colors.danger, emergency: colors.danger };
        return map[severity] || colors.danger;
    }

    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    // Shaded band beyond each threshold, stacked like a ladder: an upper rule shades up to the
    // next upper rule (or off the top of the plot), a lower rule down to the next lower rule.
    function bands(rules, colors)
    {
        var out = [];
        ["upper", "lower"].forEach(function (dir)
        {
            var up = dir === "upper";
            var list = rules.filter(function (r) { return r.direction === dir; }).sort(function (a, b) { return up ? a.value - b.value : b.value - a.value; });
            list.forEach(function (r, i)
            {
                var end = i + 1 < list.length ? list[i + 1].value : (up ? 1e9 : -1e9);
                out.push([{ yAxis: r.value, itemStyle: { color: sevColor(colors, r.severity), opacity: SEV_ALPHA[r.severity] || 0.12 } }, { yAxis: end }]);
            });
        });
        return out;
    }

    // Tick step the way ECharts picks it (1, 2, 3, 5 or 10 times a power of ten), so the bounds
    // we hand it land on a tick and the axis does not end on an odd label.
    function niceStep(x)
    {
        var p = Math.pow(10, Math.floor(Math.log10(x)));
        var f = x / p;
        return (f < 1.5 ? 1 : f < 2.5 ? 2 : f < 4 ? 3 : f < 7 ? 5 : 10) * p;
    }
    function niceBounds(lo, hi)
    {
        var step = 0, a = lo, b = hi;
        for (var i = 0; i < 3; i++)
        {
            var s = niceStep((b - a) / 5);
            if (s === step) { break; }
            step = s;
            a = +(Math.floor(lo / s) * s).toFixed(10);
            b = +(Math.ceil(hi / s) * s).toFixed(10);
        }
        return [a, b];
    }

    // Thresholds stay in view by default: people assume a limit does not exist if they cannot see
    // it. The axis spans the visible data plus every threshold, with a margin past the outermost
    // threshold so its line and label clear the plot edge. Returning null lets ECharts decide.
    // fit: the "Fit to data" toggle, which leaves thresholds out of the y axis bounds.
    function yBounds(rules, fit)
    {
        var vals = rules.map(function (r) { return r.value; });
        if (fit || !vals.length) { return { min: null, max: null }; }
        var rlo = Math.min.apply(null, vals), rhi = Math.max.apply(null, vals);
        function calc(e)
        {
            var dlo = isFinite(e.min) ? e.min : rlo, dhi = isFinite(e.max) ? e.max : rhi;
            var lo = Math.min(dlo, rlo), hi = Math.max(dhi, rhi);
            if (hi <= lo) { hi = lo + 1; }
            var pad = 0.05 * (hi - lo);
            return niceBounds(rlo < dlo ? lo - pad : lo, rhi > dhi ? hi + pad : hi);
        }
        return { min: function (e) { return calc(e)[0]; }, max: function (e) { return calc(e)[1]; } };
    }

    // Dashed line at each threshold, labelled "Alarm 40.0 C" on the side away from its band.
    function thresholdMarks(rules, colors, precision, unit)
    {
        return rules.map(function (r)
        {
            var c = sevColor(colors, r.severity);
            return { yAxis: r.value, lineStyle: { color: c, type: "dashed" }, label: { position: r.direction === "lower" ? "insideEndBottom" : "insideEndTop", color: c, formatter: cap(r.severity) + " " + r.value.toFixed(precision) + " " + unit } };
        });
    }

    // Alarm markers from the sensor's alarm events, oldest first: [{ uid, epoch (seconds), event_kind,
    // severity }] as the /data route answers with alarms=1. A raise or escalation is a right pointing
    // marker in the new severity's color; a lowering is a left pointing one in the color of the level
    // it left; a clear is a left pointing one in the severity it cleared from, the highest still
    // active (Jeff, Oct 2026). A suppressed alarm draws nothing until its suppression lifts, which
    // writes a raised event. Only markers inside [from, to] (ms) are returned, but earlier events of
    // the same alarm are needed to know the level a lowering left.
    function alarmMarkers(events, from, to)
    {
        var state = {}, out = [];
        events.forEach(function (e)
        {
            var s = state[e.uid] || (state[e.uid] = { sev: null, shown: false });
            var m = null;
            if (e.event_kind === "suppressed") { s.sev = e.severity; }
            else if (e.event_kind === "raised") { s.shown = true; m = { kind: "raised", up: true, severity: e.severity }; s.sev = e.severity; }
            else if (e.event_kind === "escalated") { if (s.shown) { m = { kind: "escalated", up: true, severity: e.severity, from: s.sev }; } s.sev = e.severity; }
            else if (e.event_kind === "de_escalated") { if (s.shown) { m = { kind: "de_escalated", up: false, severity: s.sev || e.severity, to: e.severity }; } s.sev = e.severity; }
            else if (e.event_kind === "cleared") { if (s.shown) { m = { kind: "cleared", up: false, severity: e.severity || s.sev }; } s.shown = false; }
            var t = Number(e.epoch) * 1000;
            if (m && t >= from && t <= to) { m.t = t; m.uid = e.uid; out.push(m); }
        });
        return out;
    }

    function markerText(m)
    {
        if (m.kind === "raised") { return "Alarm raised, " + m.severity; }
        if (m.kind === "escalated") { return "Escalated to " + m.severity; }
        if (m.kind === "de_escalated") { return "Lowered from " + m.severity + (m.to ? " to " + m.to : ""); }
        return "Cleared, " + m.severity;
    }

    // markLine pairs for the markers: a dotted line the height of the plot with the triangle at the
    // top. ECharts 6.1.0 puts the "from" end of a line with an infinite y at the bottom of the plot
    // and the "to" end at the top whatever the sign (MarkLineView.js updateSingleMarkerEndLayout), and
    // a one point item gives its options to the bottom end only, so each marker is a two point item
    // with the triangle on the "to" end. A triangle points up; symbolRotate -90 turns it right, 90 left.
    // Hovering a triangle shows "<time>, <what>" above the plot: a label, not a tooltip, because with
    // the axis tooltip ECharts always shows the axis tip inside the grid (TooltipView.js _tryShow).
    // Labels right of the middle are right aligned so they stay on the canvas. timeText(ms), optional,
    // puts the time in front of the text; from and to (ms) are the window.
    function alarmMarks(markers, colors, timeText, from, to)
    {
        return markers.map(function (m)
        {
            var right = m.t > (from + to) / 2;
            var c = sevColor(colors, m.severity);
            var name = (timeText ? timeText(m.t) + ", " : "") + markerText(m);
            return [
                { coord: [m.t, Infinity], symbol: "none", name: name, lineStyle: { color: c, type: "dotted", width: 1.5 }, label: { show: false, position: "end", formatter: "{b}", color: c, align: right ? "right" : "left", distance: 6 }, emphasis: { label: { show: true } } },
                { coord: [m.t, Infinity], symbol: "triangle", symbolSize: 11, symbolRotate: m.up ? -90 : 90, itemStyle: { color: c } }
            ];
        });
    }

    // The whole ECharts option for one sensor. d: { from, to (ms), unit, points [[ms, value]], rules
    // [{ direction, severity, value }], alarms (optional, events for alarmMarkers) } as the /data
    // route answers. o: { colors, precision, fit, zoom: { start, end } percentages, timeText(ms)
    // (optional, for the marker hover text) }. Without zoom it is a still image (the alarm email
    // chart, services/alarms/chartImage.js): no zoom slider or tooltip, so the plot takes the room.
    function option(d, o)
    {
        var c = o.colors;
        var z = o.zoom || { start: 0, end: 100 };
        var yb = yBounds(d.rules, o.fit);
        var opt = {
            animation: false,
            grid: { left: 48, right: 16, top: 24, bottom: 84 },
            tooltip: { trigger: "axis", valueFormatter: function (x) { return x.toFixed(o.precision) + " " + d.unit; } },
            xAxis: { type: "time", min: d.from, max: d.to, axisLabel: { color: c.textMuted }, axisLine: { lineStyle: { color: c.border } } },
            yAxis: { type: "value", scale: true, min: yb.min, max: yb.max, name: d.unit, axisLabel: { color: c.textMuted }, splitLine: { lineStyle: { color: c.border } } },
            // zoom window: slider with a preview of the series, drag inside to pan, pinch or ctrl + wheel to zoom
            dataZoom: [
                { type: "inside", xAxisIndex: 0, zoomOnMouseWheel: "ctrl", start: z.start, end: z.end },
                { type: "slider", xAxisIndex: 0, start: z.start, end: z.end, height: 28, bottom: 8, borderColor: c.border, textStyle: { color: c.textMuted }, dataBackground: { lineStyle: { color: c.primary, opacity: 0.5 }, areaStyle: { color: c.primary, opacity: 0.1 } }, selectedDataBackground: { lineStyle: { color: c.primary }, areaStyle: { color: c.primary, opacity: 0.25 } } }
            ],
            series: [{ type: "line", showSymbol: false, sampling: "minmax", data: d.points, lineStyle: { color: c.primary, width: 2 }, markArea: { silent: true, data: bands(d.rules, c) }, markLine: { silent: true, symbol: "none", data: thresholdMarks(d.rules, c, o.precision, d.unit) } }]
        };
        if (!o.zoom)
        {
            delete opt.dataZoom;
            delete opt.tooltip;
            opt.grid.bottom = 32;
        }
        // Alarm markers ride on a second series with no data, so they can be hovered while the
        // threshold lines stay silent.
        var markers = d.alarms ? alarmMarkers(d.alarms, d.from, d.to) : [];
        if (markers.length)
        {
            opt.series.push({ type: "line", name: "Alarms", data: [], markLine: { silent: false, animation: false, tooltip: { show: false }, emphasis: { lineStyle: { width: 2.5 } }, data: alarmMarks(markers, c, o.timeText, d.from, d.to) } });
        }
        return opt;
    }

    var api = { SEV_ALPHA: SEV_ALPHA, themeColors: themeColors, sevColor: sevColor, bands: bands, niceStep: niceStep, niceBounds: niceBounds, yBounds: yBounds, thresholdMarks: thresholdMarks, alarmMarkers: alarmMarkers, markerText: markerText, alarmMarks: alarmMarks, option: option };
    if (typeof module === "object" && module.exports) { module.exports = api; }
    else { root.iotSensorChart = api; }
})(this);
