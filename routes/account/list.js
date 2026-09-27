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
        const pods = await locationService.podCounts(visible.map((l) => l.id));
        for (const a of accounts)
        {
            a.pods = { account: 0, controller: 0, target: 0, athletes: null };
            for (const l of visible.filter((x) => x.account_id === a.id))
            {
                const c = pods[l.id];
                a.pods.account += c.account; a.pods.controller += c.controller; a.pods.target += c.target;
            }
        }
        res.render("account/list", { title: "Accounts", accounts: accounts });
    }
    catch (err) { next(err); }
});

module.exports = router;
