/**
 * Which supervisor runs for which manager store. The lifecycle kinds and
 * routes are registered once (extensions.js) and find the running
 * supervisor here; a manager started without --supervise has none, and the
 * apply flow refuses with NOT_SUPERVISING instead of scheduling a restart
 * nothing would perform.
 */

const supervisors = new Map();
const starters = new Map();

function register(storeDir, supervisor) {
    supervisors.set(storeDir, supervisor);
    return () => {
        if (supervisors.get(storeDir) === supervisor) supervisors.delete(storeDir);
    };
}

function get(storeDir) {
    return supervisors.get(storeDir) || null;
}

/**
 * The running manager's way to start and stop supervision after boot (the
 * setup wizard starts the workers once an install finished, and stops them
 * before an uninstall). `{ start(): Promise<Object>, stop(): Promise<Object> }`,
 * registered by apps/manager/index.js `main()`; a manager built any other way
 * (tests, the CLI) has none and the `lifecycle.start` and `lifecycle.stop`
 * kinds answer `409 NOT_AVAILABLE`.
 */
function setStarter(storeDir, starter) {
    starters.set(storeDir, starter);
    return () => {
        if (starters.get(storeDir) === starter) starters.delete(storeDir);
    };
}

function getStarter(storeDir) {
    return starters.get(storeDir) || null;
}

/**
 * The running manager's way to leave the process for the OS supervisor with a given exit code
 * (the update's handoff, documentation/manager_update.md). Registered by apps/manager/index.js
 * `main()` only when the entry script asks for it; a manager built any other way has none, and
 * an update then leaves the handoff pending for the next start.
 */
const exits = new Map();

function setExitHandler(storeDir, handler) {
    exits.set(storeDir, handler);
    return () => {
        if (exits.get(storeDir) === handler) exits.delete(storeDir);
    };
}

function getExitHandler(storeDir) {
    return exits.get(storeDir) || null;
}

module.exports = { register, get, setStarter, getStarter, setExitHandler, getExitHandler };
