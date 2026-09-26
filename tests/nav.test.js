const test = require("node:test");
const assert = require("node:assert");
const menu = require("../nav/menu");
const loc = { uid: "AAAA-BBBB", name: "Site" };

test("monitor links carry the location uid", () =>
{
    const nav = menu.resolve("/locations/aaaa-bbbb/gateways", null, loc);
    assert.equal(nav.top.label, "Devices");
    assert.equal(nav.title, "Gateways");
    assert.deepEqual(nav.breadcrumb.map((b) => b.label), ["Devices", "Gateways"]);
    assert.ok(nav.subnav.find((s) => s.active).path.endsWith("/gateways"));
    assert.ok(nav.inMonitor);
});

test("dashboard is the location root with no crumbs of its own", () =>
{
    const nav = menu.resolve("/locations/aaaa-bbbb", null, loc);
    assert.equal(nav.title, "Dashboard");
    assert.equal(nav.breadcrumb.length, 0);
});

const acct = { uid: "11111111-2222-3333-4444-555555555555", name: "Acme" };
const acctBase = "/account/11111111-2222-3333-4444-555555555555";

test("no location: monitor section empty, manage links carry the account uid", () =>
{
    const nav = menu.resolve(acctBase + "/locations", { is_superadmin: false }, null, acct);
    assert.ok(!nav.sections.some((s) => s.section === "Monitor"));
    assert.equal(nav.title, "Locations");
    assert.equal(nav.top.path, "/account");
    assert.ok(nav.subnav.every((n) => n.path.startsWith(acctBase)));
    const manage = nav.sections.find((s) => s.section === "Manage").items;
    assert.ok(!manage.some((i) => i.label === "Administration"));
    assert.equal(manage.find((i) => i.label === "Analytics").path, acctBase + "/analytics");
});

test("account list: no account, Account only, no Analytics or Reports", () =>
{
    const nav = menu.resolve("/account", null, null, null);
    assert.equal(nav.top.path, "/account");
    assert.deepEqual(nav.sections.find((s) => s.section === "Manage").items.map((i) => i.label), ["Account"]);
});

test("account overview and uid-only detail pages", () =>
{
    assert.equal(menu.resolve(acctBase, null, null, acct).title, "Overview");
    assert.equal(menu.resolve(acctBase + "/analytics", null, null, acct).top.label, "Analytics");
    assert.equal(menu.resolve("/analytics/charts/abc", null, null, acct).top.label, "Analytics");
    assert.equal(menu.resolve("/reports/abc", null, null, acct).top.label, "Reports");
});

test("unknown path yields empty nav", () =>
{
    const nav = menu.resolve("/charts/abc", null, loc);
    assert.equal(nav.top, null);
    assert.equal(nav.breadcrumb.length, 0);
});
