// Severity ladder state machine (architecture 8.2). Pure: no DB, no clock. One call per sensor
// per direction per new value. Rules carry their own clocks (breach_since, return_since).
//
// A rule "holds" from the moment its exceed duration elapses until its return duration
// elapses after the value comes back; while it holds it contributes its severity.
const ORDER = { info: 0, warning: 1, alarm: 2, emergency: 3 };

function breached(rule, value)
{
    return rule.direction === "upper" ? value > rule.threshold : value < rule.threshold;
}

// Advances one rule's clocks. Returns { changed, qualifies }.
function stepRule(rule, value, epoch)
{
    const before = { b: rule.breach_since, r: rule.return_since };
    if (breached(rule, value))
    {
        if (rule.breach_since === null || rule.breach_since === undefined) { rule.breach_since = epoch; }
        rule.return_since = null;
    }
    else if (rule.breach_since !== null && rule.breach_since !== undefined)
    {
        if (rule.return_since === null || rule.return_since === undefined) { rule.return_since = epoch; }
        if (epoch - rule.return_since >= (rule.return_secs || 0))
        {
            rule.breach_since = null;
            rule.return_since = null;
        }
    }
    const qualifies = rule.breach_since !== null && rule.breach_since !== undefined && (epoch - rule.breach_since) >= (rule.exceed_secs || 0);
    return { changed: before.b !== rule.breach_since || before.r !== rule.return_since, qualifies: qualifies };
}

// rules: enabled threshold rules for one sensor and direction (mutated: clocks advance).
// active: the current active alarm row for that direction or null.
// Returns { transition: null | "raise" | "escalate" | "de_escalate" | "clear", severity, rule, changedRules }
function evaluate(rules, active, value, epoch)
{
    const changedRules = [];
    let top = null;
    for (const rule of rules)
    {
        const r = stepRule(rule, value, epoch);
        if (r.changed) { changedRules.push(rule); }
        if (r.qualifies && (!top || ORDER[rule.severity] > ORDER[top.severity])) { top = rule; }
    }

    if (!active)
    {
        if (!top) { return { transition: null, severity: null, rule: null, changedRules: changedRules }; }
        return { transition: "raise", severity: top.severity, rule: top, changedRules: changedRules };
    }
    if (!top) { return { transition: "clear", severity: null, rule: null, changedRules: changedRules }; }
    if (ORDER[top.severity] > ORDER[active.severity]) { return { transition: "escalate", severity: top.severity, rule: top, changedRules: changedRules }; }
    if (ORDER[top.severity] < ORDER[active.severity]) { return { transition: "de_escalate", severity: top.severity, rule: top, changedRules: changedRules }; }
    return { transition: null, severity: active.severity, rule: top, changedRules: changedRules };
}

// Manual clear zeroes every breach clock so re-raise needs a full new exceed.
function zeroClocks(rules)
{
    for (const rule of rules) { rule.breach_since = null; rule.return_since = null; }
}

module.exports = { evaluate, stepRule, zeroClocks, breached, ORDER };
