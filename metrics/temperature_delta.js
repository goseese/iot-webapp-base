// Distinct from temperature: a difference has no offset, so F<->C is the ratio only
// (architecture 6.1, the superheat trap).
module.exports =
{
    slug: "temperature_delta",
    label: "Temperature difference",
    canonical: "C",
    precision: 1,
    units:
    {
        F: { label: "°F", precision: 1, toCanonical: (v) => v * 5 / 9, fromCanonical: (v) => v * 9 / 5 },
        K: { label: "K", precision: 1, toCanonical: (v) => v, fromCanonical: (v) => v }
    }
};
