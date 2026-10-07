/**
 * What the update machinery keeps in the manager store (`<store>/update/`): one small JSON
 * file per concern, written atomically, owner-only. Versions, release ids, codes, times and
 * operation ids only: never a URL, a path, a token or a file's contents.
 *
 *   last-check.json  when the last check ran, what it found
 *   staged.json      the release staged and ready to apply
 *   handoff.json     an apply that exited the manager for the OS supervisor and is not finished
 *   watchdog.json    the release to put back if the new manager never reaches `verify`
 *   recovery.json    a schema-changing update that failed after the database was in use
 *   scheduled.json   an apply waiting for its window
 *   last-apply.json  how the last apply ended (applied, rolled_back, recovery, abandoned) and its downtime
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');

const NAMES = Object.freeze(['last-check', 'staged', 'handoff', 'watchdog', 'recovery', 'scheduled', 'last-apply']);

function createUpdateState({ storeDir, fs = nodeFs, now = () => new Date() }) {
    const dir = path.join(storeDir, 'update');
    const fileOf = (name) => {
        if (!NAMES.includes(name)) throw new Error(`unknown update state file ${name}`);
        return path.join(dir, `${name}.json`);
    };

    /** The parsed document, or null when absent or unreadable (a damaged file is treated as absent: every one is re-derivable). */
    function read(name) {
        const result = files.readJson(fileOf(name), fs);
        if (!result.exists || result.problem || !files.isPlainObject(result.value)) return null;
        return result.value;
    }

    function write(name, value) {
        files.ensureDir(dir, fs);
        const doc = { version: 1, ...value, updatedAt: now().toISOString() };
        files.writeJsonAtomic(fileOf(name), doc, fs);
        return doc;
    }

    function clear(name) {
        return files.removeIfPresent(fileOf(name), fs);
    }

    return { dir, read, write, clear };
}

module.exports = { createUpdateState, NAMES };
