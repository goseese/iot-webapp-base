module.exports =
{
    slug: "acceleration", label: "Acceleration", canonical: "g", precision: 3,
    units: { mg: { label: "mg", precision: 0, toCanonical: (v) => v / 1000, fromCanonical: (v) => v * 1000 } }
};
