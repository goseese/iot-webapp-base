module.exports =
{
    slug: "data_size", label: "Data size", canonical: "B", precision: 0,
    units:
    {
        kB: { label: "kB", precision: 0, toCanonical: (v) => v * 1024, fromCanonical: (v) => v / 1024 },
        MB: { label: "MB", precision: 1, toCanonical: (v) => v * 1048576, fromCanonical: (v) => v / 1048576 }
    }
};
