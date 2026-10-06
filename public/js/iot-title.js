/*
 * iot-title.js
 * Alarm title fields (views/partials/alarm-title-field.ejs). The Tokens list inserts a token at
 * the cursor (or over the selection), and the preview line shows the title with sample values as
 * it is typed. render() follows services/alarms/title.js render(): unknown tokens stay as typed,
 * white space collapses to one space.
 */

(function ()
{
    "use strict";

    var MAX = 200;

    function render(template, vars)
    {
        return String(template).replace(/\{([a-z_]+)\}/g, function (whole, name)
        {
            if (!Object.prototype.hasOwnProperty.call(vars, name)) { return whole; }
            var v = vars[name];
            return v === null || v === undefined ? "" : String(v);
        }).replace(/\s+/g, " ").trim();
    }

    function unknownTokens(template, vars)
    {
        var out = [];
        String(template).replace(/\{([a-z_]+)\}/g, function (whole, name)
        {
            if (!Object.prototype.hasOwnProperty.call(vars, name) && out.indexOf(whole) < 0) { out.push(whole); }
            return whole;
        });
        return out;
    }

    function sampleOf(wrap)
    {
        try
        {
            return JSON.parse(wrap.dataset.sample || "{}");
        }
        catch (err)
        {
            return {};
        }
    }

    function update(wrap)
    {
        var input = wrap.querySelector("[data-title-input]");
        var preview = wrap.querySelector("[data-title-preview]");
        var warn = wrap.querySelector("[data-title-unknown]");
        if (!input || !preview) { return; }
        var vars = sampleOf(wrap);
        var template = input.value.trim() || input.placeholder;
        preview.textContent = String(vars.severity || "alarm").toUpperCase() + ": " + render(template, vars);
        var unknown = unknownTokens(template, vars);
        if (warn)
        {
            warn.textContent = unknown.length ? "Unknown token" + (unknown.length > 1 ? "s" : "") + ": " + unknown.join(", ") + " (left as typed)" : "";
            warn.classList.toggle("d-none", unknown.length === 0);
        }
    }

    // A field that has never had focus inserts at the end, not at position 0.
    document.addEventListener("focusin", function (e)
    {
        if (e.target.matches && e.target.matches("[data-title-input]")) { e.target.dataset.touched = "1"; }
    });

    document.addEventListener("input", function (e)
    {
        if (e.target.matches && e.target.matches("[data-title-input]")) { update(e.target.closest("[data-title-field]")); }
    });

    document.addEventListener("click", function (e)
    {
        var item = e.target.closest("[data-title-token]");
        if (!item) { return; }
        var wrap = item.closest("[data-title-field]");
        var input = wrap ? wrap.querySelector("[data-title-input]") : null;
        if (!input || input.disabled) { return; }
        var text = "{" + item.dataset.titleToken + "}";
        var touched = input.dataset.touched === "1";
        var start = touched ? input.selectionStart : input.value.length;
        var end = touched ? input.selectionEnd : input.value.length;
        if (input.value.length - (end - start) + text.length > MAX)
        {
            if (window.iotFlash) { window.iotFlash("warning", "An alarm title is limited to " + MAX + " characters."); }
            return;
        }
        input.focus();
        input.setRangeText(text, start, end, "end");
        input.dataset.touched = "1";
        update(wrap);
    });

    document.addEventListener("DOMContentLoaded", function ()
    {
        document.querySelectorAll("[data-title-field]").forEach(update);
    });
})();
