/* Column sorting for any table.is-sortable. A header cell sorts when it has one of:
     sort-alpha    natural text order ("Probe 2" before "Probe 10"), case insensitive
     sort-numeric  numbers; text that does not parse (blank, "none") sorts last
     sort-custom   the cell's data-sort value: numeric when it parses, otherwise natural text
   Headers without a sort class do not sort. Each cell's sort value is its data-sort attribute
   when present, otherwise its text. Clicks cycle ascending, descending, then the server's order.
   Blank values always sort last and ties keep the server's order.
   Rows are moved, never redrawn, so data-live cells keep updating. A live update does not re-sort;
   the next click sorts on current values, so live.js must keep data-sort current where a cell has one.
   Do not use on a table that simple-datatables runs (it redraws the body from its own copy).
   Tables added after load: window.iotSort.init(table). */
(function ()
{
    var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

    function sortType(th)
    {
        if (th.classList.contains("sort-alpha")) { return "alpha"; }
        if (th.classList.contains("sort-numeric")) { return "numeric"; }
        if (th.classList.contains("sort-custom")) { return "custom"; }
        return null;
    }

    function rawValue(row, col)
    {
        var cell = row.cells[col];
        if (!cell) { return ""; }
        if (cell.hasAttribute("data-sort")) { return cell.getAttribute("data-sort").trim(); }
        return (cell.textContent || "").replace(/\s+/g, " ").trim();
    }

    function toNumber(v)
    {
        if (v === "") { return NaN; }
        return parseFloat(v.replace(/,/g, ""));
    }

    // Compare two raw values for ascending order; returns null when either is blank or unusable,
    // so the caller can push it last regardless of direction.
    function compare(a, b, type)
    {
        if (type === "numeric" || type === "custom")
        {
            var na = toNumber(a);
            var nb = toNumber(b);
            if (!isNaN(na) && !isNaN(nb)) { return na - nb; }
            if (type === "numeric") { return isNaN(na) && isNaN(nb) ? 0 : (isNaN(na) ? 1 : -1); }
        }
        if (a === "" || b === "") { return a === b ? 0 : (a === "" ? 1 : -1); }
        return collator.compare(a, b);
    }

    function isBlank(v, type)
    {
        if (v === "") { return true; }
        return type === "numeric" && isNaN(toNumber(v));
    }

    function apply(table, col, type, dir)
    {
        var body = table.tBodies[0];
        if (!body) { return; }
        var rows = Array.prototype.slice.call(body.rows);
        rows.sort(function (ra, rb)
        {
            if (dir === "none") { return ra._iotSortIndex - rb._iotSortIndex; }
            var a = rawValue(ra, col);
            var b = rawValue(rb, col);
            var ba = isBlank(a, type);
            var bb = isBlank(b, type);
            if (ba || bb)
            {
                if (ba && bb) { return ra._iotSortIndex - rb._iotSortIndex; }
                return ba ? 1 : -1;
            }
            var c = compare(a, b, type);
            if (c === 0) { return ra._iotSortIndex - rb._iotSortIndex; }
            return dir === "desc" ? -c : c;
        });
        rows.forEach(function (r) { body.appendChild(r); });
    }

    function init(table)
    {
        if (!table || table._iotSort) { return; }
        table._iotSort = true;
        var body = table.tBodies[0];
        if (body) { Array.prototype.forEach.call(body.rows, function (r, i) { r._iotSortIndex = i; }); }
        var head = table.tHead && table.tHead.rows[0];
        if (!head) { return; }
        Array.prototype.forEach.call(head.cells, function (th, col)
        {
            var type = sortType(th);
            if (!type) { return; }
            th.classList.add("iot-sortable");
            th.setAttribute("tabindex", "0");
            th.setAttribute("aria-sort", "none");
            function activate()
            {
                var current = th.getAttribute("aria-sort");
                var next = current === "ascending" ? "descending" : (current === "descending" ? "none" : "ascending");
                Array.prototype.forEach.call(head.cells, function (other)
                {
                    if (other.classList.contains("iot-sortable")) { other.setAttribute("aria-sort", "none"); }
                });
                th.setAttribute("aria-sort", next);
                apply(table, col, type, next === "ascending" ? "asc" : (next === "descending" ? "desc" : "none"));
            }
            th.addEventListener("click", activate);
            th.addEventListener("keydown", function (e)
            {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
            });
        });
    }

    window.iotSort = { init: init };

    document.addEventListener("DOMContentLoaded", function ()
    {
        document.querySelectorAll("table.is-sortable").forEach(init);
    });
})();
