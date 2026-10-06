const test = require("node:test");
const assert = require("node:assert");
const h = require("../services/apiHelpers");

test("worse picks the higher severity, ok loses to anything", () =>
{
    assert.equal(h.worse("ok", "info"), "info");
    assert.equal(h.worse("alarm", "ok"), "alarm");
    assert.equal(h.worse("warning", "emergency"), "emergency");
    assert.equal(h.worse("alarm", "warning"), "alarm");
    assert.equal(h.worse("ok", "ok"), "ok");
});

test("pageByEpoch pages without gaps or repeats when epochs repeat", () =>
{
    const rows = [1, 2, 2, 3, 3, 3, 4, 5].map((e, i) => ({ id: i, epoch: e }));
    const seen = [];
    let from = 0;
    for (let guard = 0; guard < 20; guard++)
    {
        const slice = rows.filter((r) => r.epoch >= from).slice(0, 4);   // limit 3, fetched limit + 1
        const pg = h.pageByEpoch(slice, 3, "epoch");
        seen.push.apply(seen, pg.rows.map((r) => r.id));
        if (!pg.truncated) { break; }
        from = pg.next_from;
    }
    assert.deepEqual(seen, rows.map((r) => r.id));
});

test("pageByEpoch moves past a page that sits inside one second", () =>
{
    const rows = [7, 7, 7, 7].map((e, i) => ({ id: i, epoch: e }));
    const pg = h.pageByEpoch(rows, 3, "epoch");
    assert.equal(pg.rows.length, 3);
    assert.equal(pg.truncated, true);
    assert.equal(pg.next_from, 8);
});

test("pageByEpoch reports no more when everything fits", () =>
{
    const pg = h.pageByEpoch([{ epoch: 1 }], 3, "epoch");
    assert.deepEqual([pg.truncated, pg.next_from], [false, null]);
});

test("limitOf clamps and defaults", () =>
{
    assert.equal(h.limitOf(undefined, 500, 1000), 500);
    assert.equal(h.limitOf("abc", 500, 1000), 500);
    assert.equal(h.limitOf("0", 500, 1000), 500);
    assert.equal(h.limitOf("-5", 500, 1000), 500);
    assert.equal(h.limitOf("20", 500, 1000), 20);
    assert.equal(h.limitOf("99999", 500, 1000), 1000);
});

test("typedValue restores types from audit text", () =>
{
    assert.equal(h.typedValue("threshold", "8.5"), 8.5);
    assert.equal(h.typedValue("is_enabled", "1"), true);
    assert.equal(h.typedValue("use_default_group", "0"), false);
    assert.deepEqual(h.typedValue("channel_policy", "{\"raise\":{\"email\":true}}"), { raise: { email: true } });
    assert.equal(h.typedValue("alert_groups", "Coaches, Staff"), "Coaches, Staff");
    assert.equal(h.typedValue("severity", null), null);
});

test("typedValue types every field of a whole rule snapshot", () =>
{
    const snap = JSON.stringify({ rule_kind: "threshold", threshold: "10", is_enabled: "1", use_default_group: "0", exceed_secs: "300", channel_policy: "{\"raise\":{\"email\":true,\"sms\":false}}", alert_groups: null, reason: "sensor deleted" });
    assert.deepEqual(h.typedValue("deleted", snap), { rule_kind: "threshold", threshold: 10, is_enabled: true, use_default_group: false, exceed_secs: 300, channel_policy: { raise: { email: true, sms: false } }, alert_groups: null, reason: "sensor deleted" });
});
