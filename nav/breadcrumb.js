// Builds the breadcrumb trail for a page: the account first (linking to /account/<uid>), then the location while inside
// one, then the menu trail (or the page's own navTrail for detail pages). Pure and tested.
function uid(u) { return String(u).toLowerCase(); }

function build(nav, navTrail, account, currentLocation)
{
    let trail = (navTrail || (nav ? nav.breadcrumb : []) || []).map((c) => Object.assign({}, c));
    const outside = nav && nav.top && (nav.top.path === "/admin" || nav.top.path === "/support");

    if (account && !outside)
    {
        // The account crumb is the account's own page; "Account" in a page's navTrail means it.
        const home = "/account/" + uid(account.uid);
        if (trail.length && trail[0].path === "/account") { trail[0] = { label: account.name, path: home, isCurrent: trail[0].isCurrent }; }
        else { trail.unshift({ label: account.name, path: home, isCurrent: false }); }
        // The account overview itself: just the account, not "Account / Overview".
        if (trail.length > 1 && trail[1].path === home) { trail.splice(1, 1); }

        // Inside a location: Account / Location / ...; on the dashboard the location is the current crumb.
        if (nav && nav.inMonitor && currentLocation)
        {
            const root = "/locations/" + uid(currentLocation.uid);
            if (!trail.some((c) => c.path === root))
            {
                trail.splice(1, 0, { label: currentLocation.name, path: root, isCurrent: false });
            }
        }
    }

    // Collapse a child that repeats its parent (Devices / Devices) and mark the last crumb current.
    trail = trail.filter((c, i) => !(i > 0 && c.label === trail[i - 1].label && c.path === trail[i - 1].path));
    trail.forEach((c, i) => { c.isCurrent = i === trail.length - 1; });
    return trail;
}

module.exports = { build };
