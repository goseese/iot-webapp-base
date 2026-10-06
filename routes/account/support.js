// Account > Support (DECISIONS.md "Support requests"): the account's requests this user handles
// (every one with an account handle_support grant, else those sent from their granted locations).
// Anyone who is not support for the account gets the same 404 as a missing page.
const express = require("express");
const { notFoundError } = require("../../middleware/errors");
const support = require("../../services/support");

const router = express.Router({ mergeParams: true });

router.get("/support", async (req, res, next) =>
{
    try
    {
        const filter = support.filterOf(req.query.status);
        const rows = await support.listForAccount(req.user, req.account.id, filter.key);
        if (!rows) { return next(notFoundError()); }
        res.render("support/list",
        {
            title: "Support",
            rows: rows,
            filter: filter,
            base: req.acctBase + "/support",
            showAccount: false,
            empty: "No requests here."
        });
    }
    catch (err) { next(err); }
});

module.exports = router;
