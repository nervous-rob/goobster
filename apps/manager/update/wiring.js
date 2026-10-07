/**
 * What the update kinds need from the manager that built them: its engine (the recovery decision
 * runs `backup.restore` through it), the installation store and the operations journal. Kind
 * factories receive only `{ settings, fs, now, logger }`, so `createManager` binds the rest here,
 * keyed by the store directory like lifecycle/registry.js.
 */

const bound = new Map();

function bind(storeDir, parts) {
    bound.set(storeDir, parts);
    return () => {
        if (bound.get(storeDir) === parts) bound.delete(storeDir);
    };
}

function get(storeDir) {
    return bound.get(storeDir) || null;
}

const deciders = new Map();
const appliers = new Map();

/** The recovery decision as one call (set by the update kinds), for the routes and the command line. */
function setDecider(storeDir, fn) {
    deciders.set(storeDir, fn);
}

function decider(storeDir) {
    return deciders.get(storeDir) || null;
}

/** The apply machinery of the kinds, for the start-time handoff, the scheduler and the status view. */
function setApplier(storeDir, fn) {
    appliers.set(storeDir, fn);
}

function applier(storeDir) {
    const make = appliers.get(storeDir);
    return make ? make() : null;
}

module.exports = { bind, get, setDecider, decider, setApplier, applier };
