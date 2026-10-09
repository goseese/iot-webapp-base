// /account: every account the user can view, each linking to /account/<uid>. Shown even when there
// is only one, because this is also where a superadmin adds accounts.
const express = require("express");
const grants = require("../../services/grants");
const locationService = require("../../services/locations");

const router = express.Router();

router.get("/", async (req, res, next) =>
{
    try
    {
        const visible = await grants.visibleLocations(req);
        const accounts = req.visibleAccounts.map((a) => Object.assign({}, a, { locations: visible.filter((l) => l.account_id === a.id).length }));
        const counts = await locationService.deviceCounts(visible.map((l) => l.id));
        for (const a of accounts)
        {
            a.counts = { gateways: 0, devices: 0 };
            for (const l of visible.filter((x) => x.account_id === a.id))
            {
                const c = counts[l.id];
                a.counts.gateways += c.gateways; a.counts.devices += c.devices;
            }
        }
        res.render("account/list", { title: "Accounts", accounts: accounts });
    }
    catch (err) { next(err); }
});

module.exports = router;
