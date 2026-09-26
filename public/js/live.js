/* Live updates: elements with data-live="<sensorUid>:value" or ":ago" refresh in place; alarm
   transitions refresh the sidebar badge from /alarms/count.json. Nothing here changes routing. */
(function ()
{
    if (typeof io === "undefined") { return; }
    var socket = io({ transports: ["websocket", "polling"] });
    window.iotSocket = socket;      // page scripts listen for their own events (e.g. "config")
    var lastSeen = {};
    var badge = document.querySelector("[data-live-alarm-count]");
    var liveTile = document.querySelector("[data-live-status]");

    function ago(epoch)
    {
        if (!epoch) { return "never"; }
        var s = Math.floor(Date.now() / 1000) - epoch;
        if (s < 0) { s = 0; }
        if (s < 60) { return s + " s ago"; }
        if (s < 3600) { return Math.floor(s / 60) + " min ago"; }
        if (s < 86400) { return Math.floor(s / 3600) + " h ago"; }
        return Math.floor(s / 86400) + " d ago";
    }
    // Seed from the server rendered epochs so every "ago" label ticks, not only the ones that
    // received live data since the page loaded.
    document.querySelectorAll("[data-live$=':ago'][data-epoch]").forEach(function (el)
    {
        var key = el.dataset.live.replace(/:ago$/, "");
        var e = Number(el.dataset.epoch);
        if (e > 0 && (!lastSeen[key] || e > lastSeen[key])) { lastSeen[key] = e; }
    });
    // Hover shows the exact time in the browser's own timezone.
    function localStamp(epoch)
    {
        return epoch ? new Date(epoch * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }) : "";
    }
    function renderAgo(el, epoch)
    {
        el.textContent = ago(epoch);
        el.title = localStamp(epoch);
        // Keep the column sort value current (iot-sort.js); a live update never re-sorts.
        if (el.hasAttribute("data-sort")) { el.dataset.sort = epoch || ""; }
    }
    function tick()
    {
        Object.keys(lastSeen).forEach(function (key)
        {
            document.querySelectorAll('[data-live="' + key + ':ago"]').forEach(function (el) { renderAgo(el, lastSeen[key]); });
        });
    }
    tick();
    async function refreshBadge()
    {
        if (!badge) { return; }
        try
        {
            var d = await (await fetch("/alarms/count.json?location=" + encodeURIComponent(badge.dataset.location || ""))).json();
            badge.textContent = d.count;
            badge.classList.toggle("d-none", d.count === 0);
        }
        catch (e) {}
    }
    socket.on("ready", function () { if (liveTile) { liveTile.textContent = "live"; liveTile.className = "iot-status iot-status--online"; } refreshBadge(); });
    socket.on("disconnect", function () { if (liveTile) { liveTile.textContent = "reconnecting"; liveTile.className = "iot-status iot-status--warning"; } });
    function flash(el) { el.classList.add("iot-flash"); setTimeout(function () { el.classList.remove("iot-flash"); }, 800); }
    function setAll(selector, text)
    {
        document.querySelectorAll(selector).forEach(function (el) { el.textContent = text; flash(el); });
    }
    socket.on("data", function (msg)
    {
        (msg.readings || []).forEach(function (r)
        {
            if (!lastSeen[r.sensor] || r.epoch >= lastSeen[r.sensor]) { lastSeen[r.sensor] = r.epoch; }
            setAll('[data-live="' + r.sensor + ':value"]', r.display);
            document.querySelectorAll('[data-live="' + r.sensor + ':value"][data-sort]').forEach(function (el) { el.dataset.sort = typeof r.display_value === "number" ? r.display_value : ""; });
            document.querySelectorAll('[data-live="' + r.sensor + ':ago"]').forEach(function (el) { renderAgo(el, lastSeen[r.sensor]); flash(el); });
            // Sensor page chart: append the point if the chart for this sensor is on the page.
            if (window.devmonChart && window.devmonChart.sensor === r.sensor && typeof r.display_value === "number") { window.devmonChart.append(r.epoch * 1000, r.display_value); }
        });
        if (msg.device)
        {
            var dk = "device:" + msg.device;
            if (!lastSeen[dk] || msg.epoch >= lastSeen[dk]) { lastSeen[dk] = msg.epoch; }
            document.querySelectorAll('[data-live="' + dk + ':ago"]').forEach(function (el) { renderAgo(el, lastSeen[dk]); flash(el); });
        }
        if ((msg.alarms || []).length) { refreshBadge(); }
    });
    setInterval(tick, 30000);
    refreshBadge();
})();
