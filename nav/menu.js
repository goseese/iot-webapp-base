// One nested menu object drives the sidebar, breadcrumb and subnav (theme_usage.md section 3).
// The Monitor section is built per request for the current location, so every link carries
// the location uid and is shareable. Pages not in the tree (detail pages) pass their own trail
// via res.locals.navTrail.
function monitorItems(loc)
{
    const base = "/locations/" + String(loc.uid).toLowerCase();
    return [
        { label: "Dashboard", path: base, exact: true, icon: "fa-gauge-high" },
        { label: "Overview", path: base + "/overview", icon: "fa-list-check" },
        {
            label: "Devices", path: base + "/devices", icon: "fa-microchip",
            children:
            [
                { label: "Devices", path: base + "/devices", exact: true },
                { label: "Gateways", path: base + "/gateways" },
                // Assets hidden for now (Jeff, Sep 2026); the route and view still exist. Its page also
                // needs `reasons` passed from routes/locations.js before it renders.
                // { label: "Assets", path: base + "/assets" },
                { label: "Unclaimed", path: base + "/unclaimed" },
                { label: "API", path: base + "/devices/api" }
            ]
        },
        {
            label: "Alarms", path: base + "/alarms", icon: "fa-triangle-exclamation", badge: "alarms",
            children:
            [
                { label: "Active", path: base + "/alarms/active" },
                { label: "History", path: base + "/alarms/history" },
                { label: "Rules", path: base + "/alarms/rules" },
                { label: "Notifications", path: base + "/alarms/notifications" },
                { label: "API", path: base + "/alarms/api" }
            ]
        },
        { label: "Users", path: base + "/users", icon: "fa-users" },
        { label: "Settings", path: base + "/settings", icon: "fa-gear" }
    ];
}

// Manage is built per request too: while a page belongs to an account, its links carry the account
// uid (/account/<uid>/...). The Account link itself is always the account list. Analytics and
// Reports need an account, so they show only inside one; `alt` lets their uid-only detail pages
// (/analytics/charts/<uid>, /reports/<uid>) still light up the right item.
// support: services/support.openByAccount() for this user ({ all, counts }), or null. The Support
// tab shows only to users who are support for this account, with its count waiting on support,
// which the Account item carries too.
function manageItems(user, account, support)
{
    const items = [];
    if (account)
    {
        const base = "/account/" + String(account.uid).toLowerCase();
        const handles = !!support && (support.all || support.counts.has(account.id));
        const waiting = handles ? (support.counts.get(account.id) || 0) : 0;
        const children =
        [
            { label: "Overview", path: base, exact: true },
            { label: "Locations", path: base + "/locations" },
            { label: "Users", path: base + "/users" },
            { label: "Athletes", path: base + "/athletes" },
            { label: "Wristbands", path: base + "/wristbands" },
            { label: "Alert groups", path: base + "/alert-groups" },
            {
                label: "API", path: base + "/api",
                children:
                [
                    { label: "API Keys", path: base + "/api", exact: true },
                    { label: "API Docs", path: base + "/api/docs" }
                ]
            },
            {
                label: "Webhooks", path: base + "/webhooks",
                children:
                [
                    { label: "Webhooks", path: base + "/webhooks", exact: true },
                    { label: "Webhook Docs", path: base + "/webhooks/docs" }
                ]
            },
            { label: "Unclaimed devices", path: base + "/unclaimed" }
        ];
        if (handles) { children.push({ label: "Support", path: base + "/support", count: waiting }); }
        children.push({ label: "Settings", path: base + "/settings" });
        items.push(
            { label: "Account", path: "/account", exact: true, icon: "fa-building", count: waiting, children: children },
            { label: "Analytics", path: base + "/analytics", alt: "/analytics", icon: "fa-chart-line" },
            { label: "Reports", path: base + "/reports", alt: "/reports", icon: "fa-file-lines" });
    }
    else
    {
        items.push({ label: "Account", path: "/account", exact: true, icon: "fa-building" });
    }
    if (user && user.is_superadmin)
    {
        items.push(
            {
                label: "Administration", path: "/admin", icon: "fa-sliders",
                children:
                [
                    { label: "Accounts", path: "/admin/accounts" },
                    { label: "Users", path: "/admin/users" },
                    { label: "Unknown devices", path: "/admin/unknown-devices" },
                    { label: "Firmware", path: "/admin/firmware" },
                    { label: "Site settings", path: "/admin/settings" },
                    { label: "Event log", path: "/admin/logs" }
                ]
            });
    }
    return items;
}

// Support request for everyone: it opens the support modal on the page the user is on
// (views/partials/support-modal.ejs); its link, for a click without JavaScript, is the user's own
// list. Superadmins also get every request, with a badge counting requests waiting on support.
function supportItems(user)
{
    const items = [{ label: "Support request", path: "/profile/support", icon: "fa-life-ring", modal: "supportModal" }];
    if (user && user.is_superadmin)
    {
        items.push({ label: "Support requests", path: "/support", icon: "fa-inbox", badge: "support" });
    }
    return items;
}

function matches(node, path)
{
    if (node.exact) { return path === node.path; }
    if (node.alt && (path === node.alt || path.startsWith(node.alt + "/"))) { return true; }
    return path === node.path || path.startsWith(node.path + "/");
}

// Depth first: returns the chain of nodes from top level down to the deepest match.
// A parent also matches through any child (Gateways lives under Devices without sharing its path).
function findTrail(nodes, path)
{
    let best = null;
    for (const node of nodes)
    {
        const deeper = node.children ? findTrail(node.children, path) : null;
        if (!deeper && !matches(node, path)) { continue; }
        const trail = deeper ? [node].concat(deeper) : [node];
        if (!best || trail.length > best.length) { best = trail; }
    }
    return best;
}

function resolve(path, user, currentLocation, account, support)
{
    const monitor = currentLocation ? monitorItems(currentLocation) : [];
    // Monitor appears only while inside a location.
    const sections =
    [
        { section: "Monitor", scoped: true, location: currentLocation || null, items: monitor },
        { section: "Manage", items: manageItems(user, account || null, support || null) },
        { section: "Support", items: supportItems(user) }
    ].filter((s) => !s.scoped || s.items.length > 0);
    const items = sections.flatMap((s) => s.items);
    const trail = findTrail(items, path) || [];
    const top = trail[0] || null;
    const current = trail[trail.length - 1] || null;

    // Subnav shows the current node's children if it has any, else its siblings.
    let subnav = [];
    if (current)
    {
        if (current.children) { subnav = current.children; }
        else if (trail.length >= 2) { subnav = trail[trail.length - 2].children; }
    }

    const breadcrumb = trail.map((n, i) => ({ label: n.label, path: n.path, isCurrent: i === trail.length - 1 }));
    // Dashboard is the location root: its crumb is the location itself, added by the layout.
    if (breadcrumb.length && current && currentLocation && current.path === "/locations/" + String(currentLocation.uid).toLowerCase() && current.label === "Dashboard") { breadcrumb.length = 0; }

    return {
        sections: sections,
        top: top,
        current: current,
        title: current ? current.label : "",
        breadcrumb: breadcrumb,
        subnav: subnav.map((n) => ({ label: n.label, path: n.path, active: matches(n, path), count: n.count || 0 })),
        inMonitor: !!(top && monitor.includes(top))
    };
}

module.exports = { resolve, monitorItems };
