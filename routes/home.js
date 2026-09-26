// Root redirect plus the pre-9a cross-location paths. Nothing renders here. Old paths carry no
// account or location, and the session no longer remembers one (DECISIONS "Every page rebuilds
// from its URL"), so they all land on the account list.
const express = require("express");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

function toAccounts(req, res) { res.redirect("/account"); }

router.get("/", (req, res) => res.redirect(req.user ? "/account" : "/login"));
router.get("/dashboard", requireLogin, toAccounts);
router.get("/devices", requireLogin, toAccounts);
router.get("/devices/gateways", requireLogin, toAccounts);
router.get("/devices/assets", requireLogin, toAccounts);
router.get("/devices/sensors", requireLogin, toAccounts);
router.get("/alarms", requireLogin, toAccounts);
for (const p of ["active", "history", "rules", "notifications"]) { router.get("/alarms/" + p, requireLogin, toAccounts); }

module.exports = router;
