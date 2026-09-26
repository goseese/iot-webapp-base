// Battery and signal percent, ported from the legacy PHP helpers (helper_battery_tables,
// helper_battery_percent, helper_signal_tables, helper_signal_percent, helper_interp_percent).
// Pure functions; the pipeline calls them (pipeline/index.js addLevels) and stores the results as
// ordinary readings on int-vbat-pct and signal / signal-XX:XX.
//
// Points are in DESCENDING order of the raw value. Between two points the percent is linear; at or
// above the first point it is the first point's percent, at or below the last point the last
// point's; an interpolated result is rounded and kept within 1..100, as the PHP did.

// temp_coef is V per degC, 0 disables temperature correction until measured.
const BATTERY =
{
    // Legacy tables, unchanged.
    alkaline_2s:
    {
        label: "Alkaline, 2 cells", tempRef: 20.0, tempCoef: 0.0,
        points: [[3.1, 100], [2.9, 85], [2.7, 65], [2.5, 45], [2.3, 25], [2.1, 10], [1.9, 1]]
    },
    cr2477:
    {
        label: "CR2477 lithium coin cell", tempRef: 20.0, tempCoef: 0.0,
        points: [[3.0, 100], [2.9, 85], [2.8, 60], [2.7, 30], [2.6, 15], [2.4, 5], [2.1, 1]]
    },
    // PROVISIONAL (Sep 2026): a generic 3.7 V nominal Li-ion curve (4.2 V 100%, 3.9 V 75%, 3.7 V
    // 50%, 3.5 V 25%, 3.0 V 0%, ufinebattery.com lithium-ion-battery-voltage-chart), not the gw7080
    // cell's datasheet. Replace with the cell's own discharge curve when we have it. A gateway on
    // external power reads its charging voltage, which shows high.
    li_ion:
    {
        label: "Li-ion, 1 cell", tempRef: 20.0, tempCoef: 0.0,
        points: [[4.2, 100], [3.9, 75], [3.7, 50], [3.5, 25], [3.0, 1]]
    }
};

const SIGNAL =
{
    // Legacy tables, unchanged. lora and ble in dBm, csq the 3GPP index 0..31 (99 = unknown).
    lora: [[-70, 100], [-100, 85], [-115, 65], [-125, 30], [-131, 1]],
    ble: [[-50, 100], [-70, 85], [-85, 60], [-95, 30], [-107, 1]],
    csq: [[31, 100], [7, 1]],
    // Microsoft's documented WLAN signal quality mapping (WLAN_ASSOCIATION_ATTRIBUTES,
    // wlanSignalQuality): -50 dBm is 100, -100 dBm is 0, linear between. Kept at 1 as the floor,
    // like every other table here.
    wifi: [[-50, 100], [-100, 1]]
};

function interpPercent(points, v)
{
    const last = points.length - 1;
    if (v >= points[0][0]) { return Math.trunc(points[0][1]); }
    if (v <= points[last][0]) { return Math.trunc(points[last][1]); }
    for (let i = 0; i < last; i++)
    {
        const hi = points[i];
        const lo = points[i + 1];
        if (v <= hi[0] && v >= lo[0])
        {
            const frac = (v - lo[0]) / (hi[0] - lo[0]);
            const pct = lo[1] + frac * (hi[1] - lo[1]);
            return Math.max(1, Math.min(100, Math.round(pct)));
        }
    }
    return null;
}

// vbat in volts (canonical), tempC optional. 1..100, or null for an unknown chemistry or no voltage.
function batteryPercent(chemistry, vbat, tempC)
{
    const t = BATTERY[chemistry];
    if (!t) { return null; }
    let v = Number(vbat);
    if (!Number.isFinite(v) || v <= 0) { return null; }
    // Cold pulls terminal voltage down, so add back coef * (ref - temp).
    if (tempC !== null && tempC !== undefined && Number.isFinite(Number(tempC)) && t.tempCoef !== 0)
    {
        v += t.tempCoef * (t.tempRef - Number(tempC));
    }
    return interpPercent(t.points, v);
}

// rf: lora | ble | csq | wifi. 1..100, or null for an unknown radio or an unusable value.
function signalPercent(rf, value)
{
    const points = SIGNAL[rf];
    if (!points || value === null || value === undefined || value === "") { return null; }
    const v = Number(value);
    if (!Number.isFinite(v)) { return null; }
    if (rf === "csq" && (v === 99 || v < 0)) { return null; }
    return interpPercent(points, v);
}

const chemistries = Object.entries(BATTERY).map(([key, t]) => ({ key: key, label: t.label }));

module.exports = { batteryPercent, signalPercent, interpPercent, chemistries, BATTERY, SIGNAL };
