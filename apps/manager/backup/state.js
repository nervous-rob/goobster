/**
 * The restore record (`<store>/restore.json`): what a `backup.restore`
 * operation did, so a restore that stopped part way can be reasoned about
 * and re-run, and so the status says what is retained and where.
 *
 * It names sub-steps, set-aside locations and counts. It never holds a
 * passphrase, a decrypted config or a row. The locations are the
 * operator's own paths (the restore moved material there); they are not
 * copied into an audit row.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');

const STATE_FILE = 'restore.json';
const STATE_VERSION = 1;
const STATUSES = Object.freeze(['running', 'failed', 'completed']);

function createRestoreState({ storeDir, fs = nodeFs, now = () => new Date() }) {
    const file = path.join(storeDir, STATE_FILE);

    function read() {
        const result = files.readJson(file, fs);
        if (!result.exists) return { doc: null, problem: null };
        if (result.problem) return { doc: null, problem: result.problem };
        const doc = result.value;
        if (!files.isPlainObject(doc) || doc.version !== STATE_VERSION || !STATUSES.includes(doc.status) || typeof doc.id !== 'string') {
            return { doc: null, problem: 'INVALID' };
        }
        return { doc, problem: null };
    }

    function write(doc) {
        files.ensureDir(storeDir, fs);
        const next = { ...doc, version: STATE_VERSION, updatedAt: now().toISOString() };
        files.writeJsonAtomic(file, next, fs);
        return next;
    }

    function update(change) {
        const { doc } = read();
        if (!doc) return null;
        const next = change(JSON.parse(JSON.stringify(doc)));
        return next ? write(next) : doc;
    }

    function clear() {
        files.removeIfPresent(file, fs);
    }

    return { file, read, write, update, clear };
}

module.exports = { createRestoreState, STATE_FILE, STATUSES };
