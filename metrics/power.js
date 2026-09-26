module.exports =
{
    slug: "power", label: "Power", canonical: "W", precision: 1,
    units: { kW: { label: "kW", precision: 3, toCanonical: (v) => v * 1000, fromCanonical: (v) => v / 1000 } }
};
