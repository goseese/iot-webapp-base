// The password reset email, in one place: Forgot password (routes/auth.js) and Administration >
// Users "Send reset link" (routes/admin.js) both send it. Returns mail.send()'s answer
// ({ ok, notificationId, reason }) so a caller that can say so reports a failed send.
const env = require("../config/env");
const settings = require("../config/settings");
const tokens = require("./tokens");
const mail = require("./mail");

async function send(user)
{
    const minutes = settings.get("RESET_LINK_MINUTES", 60);
    const token = await tokens.issue("password_reset", "user", user.id, minutes * 60);
    return mail.send(
    {
        kind: "reset", to: user.email, recipientType: "user", recipientId: user.id,
        subject: settings.siteName() + " password reset",
        text: "Use this link to sign in and set a new password:\n\n" + env.appUrl + "/reset/" + token +
              "\n\nIt expires in " + minutes + " minutes. If you did not ask for this, ignore this message.\n"
    });
}

module.exports = { send };
