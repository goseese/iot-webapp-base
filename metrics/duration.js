module.exports =
{
    slug: "duration", label: "Duration", canonical: "s", precision: 3,
    units:
    {
        ms: { label: "ms", precision: 0, toCanonical: (v) => v / 1000, fromCanonical: (v) => v * 1000 },
        min: { label: "min", precision: 1, toCanonical: (v) => v * 60, fromCanonical: (v) => v / 60 },
        h: { label: "h", precision: 2, toCanonical: (v) => v * 3600, fromCanonical: (v) => v / 3600 }
    }
};
