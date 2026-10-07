/* Table tools for every .iot-table: a small "download" control (CSV / JSON) in the panel header,
   and a right click menu that copies the selected rows (drag-select across rows, or none = all)
   as CSV or JSON. Works from the rendered cells, so values are in display units. When a table
   is run by simple-datatables, export covers every row, not just the visible page.
   A table marked data-tools="none" gets neither: tables that are forms (site settings) or a
   short list of facts, where a download has nothing useful to carry. A single column that is
   a form or controls is left out with data-export="skip" on its header cell. */
(function ()
{
    function toolsOff(table) { return table.dataset.tools === "none"; }
    function cellText(cell) { return (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim(); }

    // Columns to export: skip selection and action columns (blank header, a control in the
    // header, or data-export="skip"), so downloads carry data only.
    function exportColumns(table)
    {
        var ths = Array.from(table.querySelectorAll("thead th"));
        var cols = [];
        ths.forEach(function (th, i)
        {
            if (th.dataset.export === "skip") { return; }
            if (th.querySelector("input, button, select")) { return; }
            var t = cellText(th);
            if (!t) { return; }
            cols.push({ index: i, label: t });
        });
        return cols;
    }
    function headersOf(table) { return exportColumns(table).map(function (c) { return c.label; }); }
    function pickCols(table, values) { return exportColumns(table).map(function (c) { return values[c.index] === undefined ? "" : values[c.index]; }); }

    // Rows as arrays of strings. If simple-datatables owns the table, take all its rows.
    function rowsOf(table, onlyRows)
    {
        if (onlyRows) { return onlyRows.map(function (tr) { return pickCols(table, Array.from(tr.cells).map(cellText)); }); }
        var dt = table._devmonDataTable;
        if (dt && dt.data && dt.data.data)
        {
            // simple-datatables 10 stores each cell as a node tree; use its text when present,
            // otherwise flatten the tree ourselves.
            var nodesToText = function (nodes)
            {
                if (!Array.isArray(nodes)) { return nodes == null ? "" : String(nodes); }
                return nodes.map(function (n) { return n.nodeName === "#text" ? (n.data || "") : nodesToText(n.childNodes || []); }).join("");
            };
            return dt.data.data.map(function (r)
            {
                return pickCols(table, r.cells.map(function (c)
                {
                    if (typeof c.text === "string") { return c.text.replace(/\s+/g, " ").trim(); }
                    if (typeof c.data === "string") { var d = document.createElement("div"); d.innerHTML = c.data; return cellText(d); }
                    return nodesToText(c.data).replace(/\s+/g, " ").trim();
                }));
            });
        }
        return Array.from(table.querySelectorAll("tbody tr")).filter(function (tr) { return !tr.classList.contains("collapse"); }).map(function (tr) { return pickCols(table, Array.from(tr.cells).map(cellText)); });
    }

    function toCsv(headers, rows)
    {
        var esc = function (v) { return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        return [headers.map(esc).join(",")].concat(rows.map(function (r) { return r.map(esc).join(","); })).join("\r\n") + "\r\n";
    }
    function toJson(headers, rows)
    {
        return JSON.stringify(rows.map(function (r) { var o = {}; headers.forEach(function (h, i) { o[h] = r[i] === undefined ? "" : r[i]; }); return o; }), null, 2);
    }
    function download(name, text, mime)
    {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: mime }));
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
    function copy(text, what)
    {
        var done = function () { if (window.iotFlash) { iotFlash("success", "Copied " + what + "."); } };
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { fallback(); }); }
        else { fallback(); }
        function fallback()
        {
            var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) {} ta.remove();
        }
    }
    function fileBase(table)
    {
        var title = document.querySelector(".iot-page-title");
        var panel = table.closest(".iot-panel");
        var head = panel ? panel.querySelector(".iot-panel__header strong") : null;
        return ((title ? title.textContent : "table") + (head ? "-" + head.textContent : "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";
    }

    // Rows intersecting the current text selection (drag across rows, shift-click, etc.).
    function selectedRows(table)
    {
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { return null; }
        var range = sel.getRangeAt(0);
        var rows = Array.from(table.querySelectorAll("tbody tr")).filter(function (tr) { return !tr.classList.contains("collapse") && range.intersectsNode(tr); });
        return rows.length ? rows : null;
    }

    // ---- download control in the panel header
    function addDownload(table)
    {
        var panel = table.closest(".iot-panel");
        if (!panel) { return; }
        var header = panel.querySelector(".iot-panel__header");
        if (!header)
        {
            // No panel header on this page: add a slim toolbar above the table for the button.
            header = document.createElement("div");
            header.className = "iot-panel__header justify-content-end";
            panel.insertBefore(header, panel.firstChild);
        }
        if (header.querySelector(".iot-table-dl")) { return; }
        var wrap = document.createElement("div");
        wrap.className = "dropdown iot-table-dl ms-auto";
        wrap.innerHTML = '<button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" title="Download this table"><i class="fa-solid fa-download me-1"></i>Download</button>' +
            '<ul class="dropdown-menu dropdown-menu-end"><li><a class="dropdown-item" href="#" data-dl="csv">Download CSV</a></li><li><a class="dropdown-item" href="#" data-dl="json">Download JSON</a></li></ul>';
        header.classList.add("d-flex", "align-items-center", "gap-2");
        header.appendChild(wrap);
        wrap.addEventListener("click", function (e)
        {
            var a = e.target.closest("[data-dl]");
            if (!a) { return; }
            e.preventDefault();
            var h = headersOf(table), r = rowsOf(table, null);
            if (a.dataset.dl === "csv") { download(fileBase(table) + ".csv", toCsv(h, r), "text/csv"); }
            else { download(fileBase(table) + ".json", toJson(h, r), "application/json"); }
        });
    }

    // ---- right click menu
    var menu = null;
    function getMenu()
    {
        if (menu) { return menu; }
        menu = document.createElement("div");
        menu.className = "dropdown-menu iot-context-menu";
        menu.innerHTML = '<h6 class="dropdown-header" data-ctx-title></h6>' +
            '<a class="dropdown-item" href="#" data-ctx="csv">Copy as CSV</a>' +
            '<a class="dropdown-item" href="#" data-ctx="json">Copy as JSON</a>' +
            '<div class="dropdown-divider"></div>' +
            '<a class="dropdown-item" href="#" data-ctx="dl-csv">Download table as CSV</a>' +
            '<a class="dropdown-item" href="#" data-ctx="dl-json">Download table as JSON</a>';
        document.body.appendChild(menu);
        document.addEventListener("click", function () { menu.classList.remove("show"); });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") { menu.classList.remove("show"); } });
        return menu;
    }
    document.addEventListener("contextmenu", function (e)
    {
        var table = e.target.closest("table.iot-table");
        if (!table || toolsOff(table) || e.target.closest("input, textarea, select, a, button")) { return; }
        e.preventDefault();
        var m = getMenu();
        var rows = selectedRows(table);
        var scope = rows ? rows.length + " selected row" + (rows.length === 1 ? "" : "s") : "all rows";
        m.querySelector("[data-ctx-title]").textContent = "Copy " + scope;
        m.style.left = Math.min(e.pageX, window.scrollX + window.innerWidth - 240) + "px";
        m.style.top = e.pageY + "px";
        m.classList.add("show");
        m.onclick = function (ev)
        {
            var a = ev.target.closest("[data-ctx]");
            if (!a) { return; }
            ev.preventDefault();
            m.classList.remove("show");
            var h = headersOf(table);
            if (a.dataset.ctx === "csv") { copy(toCsv(h, rowsOf(table, rows)), scope + " as CSV"); }
            else if (a.dataset.ctx === "json") { copy(toJson(h, rowsOf(table, rows)), scope + " as JSON"); }
            else if (a.dataset.ctx === "dl-csv") { download(fileBase(table) + ".csv", toCsv(h, rowsOf(table, null)), "text/csv"); }
            else { download(fileBase(table) + ".json", toJson(h, rowsOf(table, null)), "application/json"); }
        };
    });

    // Shared with iot-chart-tools.js so chart downloads write files the same way tables do.
    window.iotExport = { toCsv: toCsv, toJson: toJson, download: download };

    document.addEventListener("DOMContentLoaded", function ()
    {
        document.querySelectorAll("table.iot-table").forEach(function (t) { if (t.tHead && t.tHead.rows.length && !toolsOff(t)) { addDownload(t); } });
    });
})();
