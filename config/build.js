// Build identity for the footer and /health: package version, git commit, boot time.
// Commit resolution order: public/build-info.json written by the customer pipeline
// ({ "fullCommit", "branch", "buildNumber", "builtAtUtc", ... }), then build.json written by
// the deploy pipeline ({ "commit": "...", "builtAt": "..." }), then GIT_COMMIT in the
// environment, then the .git directory of the checkout (no git binary needed), else "unknown".
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));

function fromBuildInfo()
{
    try
    {
        const b = JSON.parse(fs.readFileSync(path.join(root, "public", "build-info.json"), "utf8"));
        const commit = String(b.fullCommit || b.commit || "").slice(0, 40);
        if (!commit) { return null; }
        const info =
        {
            commit: commit,
            branch: b.branch ? String(b.branch).replace("refs/heads/", "") : null,
            buildNumber: b.buildNumber || null,
            builtAt: b.builtAtUtc || null,
            source: "build-info.json"
        };
        return info;
    }
    catch (err) { return null; }
}

function fromBuildJson()
{
    try
    {
        const b = JSON.parse(fs.readFileSync(path.join(root, "build.json"), "utf8"));
        return { commit: String(b.commit || "").slice(0, 40), builtAt: b.builtAt || null, source: "build.json" };
    }
    catch (err) { return null; }
}

function fromGitDir()
{
    try
    {
        const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
        if (!head.startsWith("ref:")) { return { commit: head, source: ".git" }; }
        const ref = head.slice(4).trim();
        const refFile = path.join(root, ".git", ref);
        if (fs.existsSync(refFile)) { return { commit: fs.readFileSync(refFile, "utf8").trim(), branch: ref.replace("refs/heads/", ""), source: ".git" }; }
        const packed = fs.readFileSync(path.join(root, ".git", "packed-refs"), "utf8");
        const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
        return line ? { commit: line.split(" ")[0], branch: ref.replace("refs/heads/", ""), source: ".git" } : null;
    }
    catch (err) { return null; }
}

const info = fromBuildInfo() || fromBuildJson() || (process.env.GIT_COMMIT ? { commit: process.env.GIT_COMMIT, source: "env" } : null) || fromGitDir() || { commit: "unknown", source: "none" };

module.exports =
{
    version: pkg.version,
    commit: info.commit,
    shortCommit: info.commit === "unknown" ? "unknown" : info.commit.slice(0, 7),
    branch: info.branch || null,
    buildNumber: info.buildNumber || null,
    builtAt: info.builtAt || null,
    source: info.source,
    bootedAt: new Date()
};
