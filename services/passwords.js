// One validator for every page that sets a password (architecture 4.1); policy from settings.
const bcrypt = require("bcryptjs");
const settings = require("../config/settings");

function policy()
{
    return {
        minLength: settings.get("PW_MIN_LENGTH", 10),
        upper: settings.get("PW_REQUIRE_UPPER", true),
        lower: settings.get("PW_REQUIRE_LOWER", true),
        digit: settings.get("PW_REQUIRE_DIGIT", true),
        symbol: settings.get("PW_REQUIRE_SYMBOL", false)
    };
}

// Returns null when acceptable, otherwise a sentence saying what to fix.
function check(password)
{
    const p = policy();
    const problems = [];
    if (!password || password.length < p.minLength) { problems.push("at least " + p.minLength + " characters"); }
    if (p.upper && !/[A-Z]/.test(password || "")) { problems.push("an upper case letter"); }
    if (p.lower && !/[a-z]/.test(password || "")) { problems.push("a lower case letter"); }
    if (p.digit && !/[0-9]/.test(password || "")) { problems.push("a digit"); }
    if (p.symbol && !/[^A-Za-z0-9]/.test(password || "")) { problems.push("a symbol"); }
    return problems.length === 0 ? null : "Password needs " + problems.join(", ") + ".";
}

function describe()
{
    const p = policy();
    const parts = [p.minLength + "+ characters"];
    if (p.upper) { parts.push("upper case"); }
    if (p.lower) { parts.push("lower case"); }
    if (p.digit) { parts.push("a digit"); }
    if (p.symbol) { parts.push("a symbol"); }
    return parts.join(", ");
}

function hash(password)
{
    return bcrypt.hash(password, 12);
}

function verify(password, storedHash)
{
    if (!storedHash) { return Promise.resolve(false); }
    return bcrypt.compare(password, storedHash);
}

module.exports = { check, describe, hash, verify };
