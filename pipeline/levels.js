// Stage 2 prelude: battery and signal percent. Pure (no database), so it is unit tested
// (tests/levels.test.js); pipeline/index.js calls it before sensors are created.
const metrics = require("../metrics");
const levels = require("../services/levels");

// Battery and signal percent (services/levels.js), added to the same message as ordinary readings,
// so their sensors are created on first value like any other. int-vbat-pct from int-vbat and the
// device's chemistry (its own setting, else the type's batteryChemistry), temperature from int-temp
// in the same message or the sensor's last value. A channel declaring signal: "<radio>" gives
// "signal" with the same per gateway suffix (rssi-72:b4 -> signal-72:b4, csq -> signal). Only for
// channels the type declares, and never over a value the message already carries.
function addLevels(input, type, byChannel, defOf)
{
    const values = Object.assign({}, input.values);
    const canonical = (channel) =>
    {
        const def = defOf(channel);
        const num = Number(values[channel]);
        if (!def || values[channel] === null || values[channel] === undefined || values[channel] === "" || !Number.isFinite(num)) { return null; }
        const unit = input.canonical ? metrics.get(def.metric).canonical : (def.inboundUnit || metrics.get(def.metric).canonical);
        return metrics.toCanonical(def.metric, num, unit);
    };

    const chemistry = input.device.battery_chemistry || type.batteryChemistry;
    if (chemistry && values["int-vbat-pct"] === undefined && defOf("int-vbat-pct"))
    {
        const vbat = canonical("int-vbat");
        if (vbat !== null)
        {
            let temp = canonical("int-temp");
            if (temp === null && byChannel.has("int-temp")) { temp = byChannel.get("int-temp").last_value; }
            const pct = levels.batteryPercent(chemistry, vbat, temp === undefined ? null : temp);
            if (pct !== null) { values["int-vbat-pct"] = pct; }
        }
    }

    for (const channel of Object.keys(input.values))
    {
        const def = defOf(channel);
        if (!def || !def.signal) { continue; }
        const key = "signal" + (def.base ? channel.slice(def.base.id.length) : "");
        if (values[key] !== undefined || !defOf(key)) { continue; }
        const pct = levels.signalPercent(def.signal, canonical(channel));
        if (pct !== null) { values[key] = pct; }
    }
    return Object.assign({}, input, { values: values });
}

module.exports = { addLevels };
