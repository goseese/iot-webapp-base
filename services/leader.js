// Single server (Ubuntu, pm2): exactly one process runs the ingest role, so there is no election.
// "Leader" means that process. start() hands off to ingest and jobs at once; isLeader() is true
// only in the process that called start(), so web only processes still report false.
let leader = false;

function start(callback)
{
    leader = true;
    callback();
}

function isLeader()
{
    return leader;
}

module.exports = { start, isLeader };
