module.exports =
{
    slug: "temperature",
    label: "Temperature",
    canonical: "C",
    precision: 1,
    units:
    {
        F: { label: "°F", precision: 1, toCanonical: (v) => (v - 32) * 5 / 9, fromCanonical: (v) => v * 9 / 5 + 32 },
        K: { label: "K", precision: 1, toCanonical: (v) => v - 273.15, fromCanonical: (v) => v + 273.15 }
    }
};
