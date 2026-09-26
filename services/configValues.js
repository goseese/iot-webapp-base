// Gateway config values, pure (no database), so they unit test: validation of what is typed on the
// config page and the normalizing that lets a unit's echo be compared with what was sent
// (services/unitConfig.js). def is a configKeys entry from the device type module.
const MAX_VALUE = 99;      // the firmware's confirm buffer is char[100]

function normalize(def, value)
{
    if (value === null || value === undefined) { return null; }
    const v = String(value).trim();
    const kind = def ? def.kind : "string";
    if (kind === "int") { return /^-?\d+$/.test(v) ? String(parseInt(v, 10)) : v; }
    if (kind === "float")
    {
        const n = Number(v);
        return v !== "" && Number.isFinite(n) ? n.toFixed(def.decimals === undefined ? 1 : def.decimals) : v;
    }
    if (kind === "bool") { return ["true", "1", "yes"].includes(v.toLowerCase()) ? "true" : "false"; }
    if (kind === "hexlist")
    {
        return v.split(",").map((x) => x.trim()).filter((x) => x.length > 0)
            .map((x) => /^[0-9a-fA-F]{1,2}$/.test(x) ? parseInt(x, 16).toString(16) : x.toLowerCase())
            .filter((x) => x !== "0").join(",");
    }
    return v;
}

// A value typed on the page -> { ok, value } with the value to send, or { ok: false, error }.
function validate(def, raw)
{
    const v = String(raw === undefined || raw === null ? "" : raw).trim();
    const maxLength = def.maxLength !== undefined ? Math.min(def.maxLength, MAX_VALUE) : MAX_VALUE;
    if (v.length > maxLength) { return { ok: false, error: "At most " + maxLength + " characters." }; }
    if (def.kind === "int")
    {
        if (!/^-?\d+$/.test(v)) { return { ok: false, error: "Enter a whole number." }; }
        const n = parseInt(v, 10);
        if (def.min !== undefined && n < def.min) { return { ok: false, error: "Minimum is " + def.min + "." }; }
        if (def.max !== undefined && n > def.max) { return { ok: false, error: "Maximum is " + def.max + "." }; }
    }
    if (def.kind === "float" && (v === "" || !Number.isFinite(Number(v)))) { return { ok: false, error: "Enter a number." }; }
    if (def.kind === "bool" && !["true", "false", "1", "0", "yes", "no"].includes(v.toLowerCase())) { return { ok: false, error: "Choose true or false." }; }
    if (def.kind === "hexlist")
    {
        const parts = v.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
        if (parts.length > 10) { return { ok: false, error: "At most 10 frame types." }; }
        if (!parts.every((x) => /^[0-9a-fA-F]{1,2}$/.test(x) && parseInt(x, 16) > 0)) { return { ok: false, error: "Comma separated hex values 1 to ff." }; }
    }
    return { ok: true, value: normalize(def, v) };
}

module.exports = { MAX_VALUE, normalize, validate };
