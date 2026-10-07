/**
 * The tombstone: `tombstone.json` in the manager store's parent directory.
 * After a full-data uninstall nothing else says "an installation was here",
 * so without it the host would look unclaimed and a remote first-claim could
 * take it. While the file exists the manager is in the recovery state
 * (`MANAGER_TOMBSTONED`), `claim` is refused, and only the local recovery
 * flow can install again. documentation/manager_install.md.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');

const TOMBSTONE_VERSION = 1;

function tombstonePath(storeDir) {
    return path.join(path.dirname(storeDir), 'tombstone.json');
}

/** @returns {{ present: boolean, doc: Object|null }} a damaged file still counts as present */
function readTombstone(storeDir, fs = nodeFs) {
    const read = files.readJson(tombstonePath(storeDir), fs);
    if (!read.exists) return { present: false, doc: null };
    const value = read.value;
    if (read.problem || !files.isPlainObject(value) || value.version !== TOMBSTONE_VERSION || typeof value.installationId !== 'string') {
        return { present: true, doc: null };
    }
    return { present: true, doc: { installationId: value.installationId, removedAt: value.removedAt, operationId: value.operationId || null } };
}

function writeTombstone(storeDir, { installationId, operationId = null, now = () => new Date() }, fs = nodeFs) {
    const file = tombstonePath(storeDir);
    files.ensureDir(path.dirname(file), fs);
    files.writeJsonAtomic(file, { version: TOMBSTONE_VERSION, installationId, removedAt: now().toISOString(), operationId }, fs);
    return file;
}

function removeTombstone(storeDir, fs = nodeFs) {
    return files.removeIfPresent(tombstonePath(storeDir), fs);
}

module.exports = { TOMBSTONE_VERSION, tombstonePath, readTombstone, writeTombstone, removeTombstone };
