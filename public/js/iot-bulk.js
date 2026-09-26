/* Bulk actions for list tables (DECISIONS.md, "Bulk actions share one pattern"). The page renders
   the bar and modal from views/partials/bulk-bar.ejs and bulk-modal.ejs, marks each row
   <tr data-bulk-uid data-bulk-name> with an input.bulk-pick, and calls iotBulk.init() on
   DOMContentLoaded with its actions:

     iotBulk.init({
         table: "activeAlarms",
         csrf: "...",
         noun: ["alarm", "alarms"],
         actions:
         {
             clear:
             {
                 label: "Clear", doing: "Clearing", done: "Cleared", danger: true,
                 skip: function (tr) { return tr.dataset.canClear === "1" ? null : "no permission at that location"; },
                 url: function (tr) { return "/alarms/" + tr.dataset.bulkUid + "/clear"; },
                 body: function (form) { return { comment: "..." }; },    // null = invalid, stay on the form
                 apply: function (tr, state) { }                          // show the row's new state
             }
         }
     });

   Modal fields marked data-bulk-for="clear ack" show only for those actions. Rows are posted one
   at a time, in order, to the single action endpoint with accept: application/json; the
   endpoint answers { ok, message, state }. */
(function ()
{
    function el(id) { return document.getElementById(id); }
    function plural(noun, n) { return n === 1 ? noun[0] : noun[1]; }

    function init(opts)
    {
        var table = typeof opts.table === "string" ? el(opts.table) : opts.table;
        var checkAll = el("bulkCheckAll");
        if (!table || !checkAll) { return; }
        var noun = opts.noun || ["row", "rows"];
        var bar = el("bulkBar"), count = el("bulkCount");
        var modalEl = el("bulkModal"), modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        var form = el("bulkForm"), go = el("bulkGo"), cancel = el("bulkCancel");
        var key = null, action = null, rows = [], running = false;

        function allRows() { return Array.from(table.querySelectorAll("tbody tr[data-bulk-uid]")); }
        function enabledPicks() { return Array.from(table.querySelectorAll(".bulk-pick")).filter(function (c) { return !c.disabled; }); }
        function picks() { return allRows().filter(function (tr) { var c = tr.querySelector(".bulk-pick"); return c && c.checked && !c.disabled; }); }

        function refresh()
        {
            var n = picks().length, all = enabledPicks().length;
            bar.classList.toggle("d-none", n === 0);
            count.textContent = n + " selected";
            checkAll.checked = all > 0 && n === all;
            checkAll.indeterminate = n > 0 && n < all;
        }

        table.addEventListener("change", function (e) { if (e.target.classList.contains("bulk-pick")) { refresh(); } });
        checkAll.addEventListener("change", function ()
        {
            enabledPicks().forEach(function (c) { c.checked = checkAll.checked; });
            refresh();
        });
        el("bulkNone").addEventListener("click", function () { checkAll.checked = false; checkAll.dispatchEvent(new Event("change")); });

        // While a run is in progress the modal cannot be closed.
        modalEl.addEventListener("hide.bs.modal", function (e) { if (running) { e.preventDefault(); } });

        function openFor(k)
        {
            key = k; action = opts.actions[k];
            var all = picks(), skipped = {};
            rows = all.filter(function (tr)
            {
                var reason = action.skip ? action.skip(tr) : null;
                if (reason) { skipped[reason] = (skipped[reason] || 0) + 1; }
                return !reason;
            });

            el("bulkTitle").textContent = action.label + " " + rows.length + " " + plural(noun, rows.length);
            el("bulkSkipNote").textContent = Object.keys(skipped).map(function (reason)
            {
                return skipped[reason] + " selected " + plural(noun, skipped[reason]) + " skipped: " + reason + ".";
            }).join(" ");

            form.querySelectorAll("[data-bulk-for]").forEach(function (f) { f.classList.toggle("d-none", f.dataset.bulkFor.split(" ").indexOf(k) === -1); });
            form.querySelectorAll("input[type=text], input:not([type]), textarea").forEach(function (i) { i.value = ""; });
            form.querySelectorAll(".is-invalid").forEach(function (i) { i.classList.remove("is-invalid"); });
            form.classList.remove("d-none");
            el("bulkProgress").classList.add("d-none");
            el("bulkProgressBar").style.width = "0%";
            el("bulkErrors").innerHTML = "";

            go.classList.remove("d-none");
            go.disabled = rows.length === 0;
            go.textContent = action.label;
            go.className = "btn " + (action.danger ? "btn-danger" : "btn-primary");
            cancel.textContent = "Cancel";
            modal.show();
        }

        document.querySelectorAll("[data-bulk]").forEach(function (b)
        {
            b.addEventListener("click", function () { if (opts.actions[b.dataset.bulk]) { openFor(b.dataset.bulk); } });
        });

        go.addEventListener("click", async function ()
        {
            var body = action.body ? action.body(form) : {};
            if (body === null) { return; }

            var progress = el("bulkProgressBar"), status = el("bulkStatus"), errors = el("bulkErrors");
            running = true;
            go.disabled = true; cancel.disabled = true;
            modalEl.querySelectorAll(".btn-close").forEach(function (b) { b.disabled = true; });
            form.classList.add("d-none");
            el("bulkProgress").classList.remove("d-none");
            rows.forEach(function (tr) { tr.classList.remove("iot-row-failed"); tr.classList.add("iot-row-pending"); });

            var ok = 0, fail = 0;
            for (var i = 0; i < rows.length; i++)
            {
                var tr = rows[i];
                status.textContent = (action.doing || action.label) + " " + (i + 1) + " of " + rows.length + "...";
                try
                {
                    var res = await fetch(action.url(tr), { method: "POST", headers: { "content-type": "application/json", "accept": "application/json", "x-csrf-token": opts.csrf }, body: JSON.stringify(body) });
                    var d = await res.json().catch(function () { return { ok: false, message: "HTTP " + res.status }; });
                    if (!res.ok || !d.ok) { throw new Error(d.message || ("HTTP " + res.status)); }
                    ok++;
                    if (action.apply) { action.apply(tr, d.state || {}); }
                }
                catch (err)
                {
                    fail++;
                    var li = document.createElement("li");
                    li.textContent = (tr.dataset.bulkName || tr.dataset.bulkUid) + ": " + err.message;
                    errors.appendChild(li);
                    tr.classList.add("iot-row-failed");
                }
                tr.classList.remove("iot-row-pending");
                var pick = tr.querySelector(".bulk-pick"); if (pick) { pick.checked = false; }
                progress.style.width = Math.round(((i + 1) / rows.length) * 100) + "%";
            }

            running = false;
            refresh();
            status.textContent = action.done + " " + ok + " of " + rows.length + " " + plural(noun, rows.length) + (fail ? ", " + fail + " failed." : ".");
            go.classList.add("d-none");
            cancel.textContent = "Close"; cancel.disabled = false;
            modalEl.querySelectorAll(".btn-close").forEach(function (b) { b.disabled = false; });
            if (window.iotFlash) { iotFlash(fail ? "warning" : "success", status.textContent); }
        });

        refresh();
    }

    window.iotBulk = { init: init };
})();
