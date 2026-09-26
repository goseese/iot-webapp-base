// Account area, one file per page. All pages require login. /account lists the accounts the user
// can view; every account page lives under /account/<account uid> (middleware/account.js).
const express = require("express");
const { requireLogin } = require("../../middleware/auth");
const { loadAccount } = require("../../middleware/account");

const router = express.Router();
router.use(requireLogin);
router.use("/", require("./list"));

const account = express.Router({ mergeParams: true });
account.use("/", require("./overview"));
account.use("/", require("./users"));
account.use("/", require("./alert-groups"));
account.use("/", require("./settings"));
account.use("/", require("./api"));
account.use("/", require("./unclaimed"));
account.use("/analytics", require("../charts"));
account.use("/reports", require("../reports"));
router.use("/:accountUid", loadAccount, account);

module.exports = router;
