// /account: every account the user can view, each linking to /account/<uid>. Shown even when there
// is only one, because this is also where a superadmin adds accounts.
const express = require("express");
const { knex, T } = require("../../db/knex");
const grants = require("../../services/grants");

const router = express.Router();

router.get("/", async (req, res, next) =>
{
    try
    {
        const visible = await grants.visibleLocations(req);
        const accounts = req.visibleAccounts.map((a) => Object.assign({}, a, { locations: visible.filter((l) => l.account_id === a.id).length }));
        const ids = accounts.map((a) => a.id);
        if (ids.length)
        {
            const rows = await knex(T("alarms") + " as x").join(T("sensors") + " as s", "s.id", "x.sensor_id").join(T("devices") + " as d", "d.id", "s.device_id").join(T("locations") + " as l", "l.id", "d.location_id")
                .whereIn("l.id", visible.map((l) => l.id).concat([-1])).whereNull("x.cleared_epoch").groupBy("l.account_id").select("l.account_id").count("x.id as n");
            for (const a of accounts) { const r = rows.find((x) => x.account_id === a.id); a.alarms = r ? Number(r.n) : 0; }
        }
        res.render("account/list", { title: "Accounts", accounts: accounts });
    }
    catch (err) { next(err); }
});

module.exports = router;
