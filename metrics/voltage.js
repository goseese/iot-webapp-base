module.exports =
{
    slug: "voltage", label: "Voltage", canonical: "V", precision: 2,
    units: { mV: { label: "mV", precision: 0, toCanonical: (v) => v / 1000, fromCanonical: (v) => v * 1000 } }
};
