module.exports =
{
    slug: "current", label: "Current", canonical: "A", precision: 2,
    units: { mA: { label: "mA", precision: 0, toCanonical: (v) => v / 1000, fromCanonical: (v) => v * 1000 } }
};
