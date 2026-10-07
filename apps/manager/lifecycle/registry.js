/**
 * Which supervisor runs for which manager store. The lifecycle kinds and
 * routes are registered once (extensions.js) and find the running
 * supervisor here; a manager started without --supervise has none, and the
 * apply flow refuses with NOT_SUPERVISING instead of scheduling a restart
 * nothing would perform.
 */

const supervisors = new Map();

function register(storeDir, supervisor) {
    supervisors.set(storeDir, supervisor);
    return () => {
        if (supervisors.get(storeDir) === supervisor) supervisors.delete(storeDir);
    };
}

function get(storeDir) {
    return supervisors.get(storeDir) || null;
}

module.exports = { register, get };
