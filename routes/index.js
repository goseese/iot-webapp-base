const express = require("express");

const router = express.Router();

router.use("/", require("./auth"));
router.use("/", require("./alarm-action"));
router.use("/profile", require("./profile"));
router.use("/account", require("./account"));
router.use("/locations", require("./locations"));
router.use("/devices", require("./devices"));
router.use("/sensors", require("./sensors"));
router.use("/alarms", require("./alarms"));
router.use("/analytics", require("./charts"));
router.use("/reports", require("./reports"));
router.use("/admin", require("./admin"));
router.use("/", require("./home"));

module.exports = router;
