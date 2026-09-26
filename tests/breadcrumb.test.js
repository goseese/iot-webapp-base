const test = require("node:test");
const assert = require("node:assert");
const menu = require("../nav/menu");
const breadcrumb = require("../nav/breadcrumb");
const loc = { uid: "AAAA", name: "Site" };
const account = { uid: "AAAA-1111", name: "Acme" };
const labels = (t) => t.map((c) => c.label + (c.isCurrent ? "*" : ""));

test("location pages: account, location, menu trail", () =>
{
    const nav = menu.resolve("/locations/aaaa/gateways", null, loc);
    assert.deepEqual(labels(breadcrumb.build(nav, null, account, loc)), ["Acme", "Site", "Devices", "Gateways*"]);
});

test("dashboard: location is the current crumb", () =>
{
    const nav = menu.resolve("/locations/aaaa", null, loc);
    assert.deepEqual(labels(breadcrumb.build(nav, null, account, loc)), ["Acme", "Site*"]);
});

test("devices page collapses the repeated child", () =>
{
    const nav = menu.resolve("/locations/aaaa/devices", null, loc);
    assert.deepEqual(labels(breadcrumb.build(nav, null, account, loc)), ["Acme", "Site", "Devices*"]);
});

test("account pages and admin", () =>
{
    assert.deepEqual(labels(breadcrumb.build(menu.resolve("/account", null, null, null), null, null, null)), ["Account*"]);
    assert.deepEqual(labels(breadcrumb.build(menu.resolve("/account/aaaa-1111", null, null, account), null, account, null)), ["Acme*"]);
    const t = breadcrumb.build(menu.resolve("/account/aaaa-1111/locations", null, null, account), null, account, null);
    assert.deepEqual(labels(t), ["Acme", "Locations*"]);
    assert.equal(t[0].path, "/account/aaaa-1111");
    assert.deepEqual(labels(breadcrumb.build(menu.resolve("/admin/settings", { is_superadmin: true }, null), null, account, null)), ["Administration", "Site settings*"]);
});

test("detail page trail keeps its own location crumb", () =>
{
    const nav = menu.resolve("/devices/x", null, loc);
    const own = [{ label: "Account", path: "/account" }, { label: "Site", path: "/locations/aaaa" }, { label: "Devices", path: "/locations/aaaa/devices" }, { label: "GW", path: "/devices/x", isCurrent: true }];
    const t = breadcrumb.build(nav, own, account, loc);
    assert.deepEqual(labels(t), ["Acme", "Site", "Devices", "GW*"]);
    assert.equal(t[0].path, "/account/aaaa-1111");
});
