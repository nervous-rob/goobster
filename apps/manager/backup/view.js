/**
 * What the manager shows about backups and restores
 * (documentation/backup_and_restore.md): the inspection of one archive and
 * the status of the last restore. Reads the manager store and the archive
 * directory only; no application database is opened and nothing is written.
 *
 * An inspection echoes the one path it was asked about and nothing else of
 * the file system (the list of what a restore would replace is file-set
 * ids). No view carries a passphrase, a value out of config.json or a row.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { ManagerError } = require('../errors');
const { createStore } = require('../store/installation');
const { createRestoreState } = require('./state');
const backupPaths = require('./paths');
const { lazy } = require('../lazy');

const archive = lazy('@goobster/core/services/backupArchive');

function readRecord(settings, fs) {
    const read = createStore({ root: settings.storeDir, fs }).readInstallation();
    return read.status === 'ok' ? read.doc : null;
}

function targetEngine(settings) {
    return settings.dbUrl ? 'postgres' : 'sqlite';
}

/** @returns {Object} the inspection view of the archive at `dir` */
function inspectArchive({ settings, dir, fs = nodeFs }) {
    let resolved;
    try {
        resolved = backupPaths.parseDirectory(dir, 'dir');
    } catch {
        throw new ManagerError(400, 'INVALID_INPUT', '"dir" must be an absolute directory path without ".." parts.');
    }
    const listing = backupPaths.describeDirectory(resolved, fs);
    if (!listing.exists || !listing.directory) throw new ManagerError(404, 'NOT_AN_ARCHIVE', `${resolved} is not a directory.`);
    let manifest;
    try {
        manifest = archive.inspectBackup(resolved);
    } catch (error) {
        if (error && error.name === 'BackupError') throw new ManagerError(409, error.code, error.message);
        throw error;
    }
    const engine = targetEngine(settings);
    const view = archive.describeManifest(manifest, { targetEngine: engine });
    let integrity = { ok: true, problems: [] };
    try {
        archive.verifyBackup(resolved, { expectFingerprint: manifest.schemaFingerprint });
    } catch (error) {
        integrity = { ok: false, problems: Array.isArray(error.problems) ? error.problems : ['UNVERIFIED'] };
    }
    let insideData = false;
    try {
        backupPaths.assertSource(settings, resolved);
    } catch {
        insideData = true;
    }
    const record = readRecord(settings, fs);
    const blocks = [];
    if (!view.engineMatches) blocks.push('ENGINE_MISMATCH');
    if (!integrity.ok) blocks.push('ARCHIVE_INCOMPLETE');
    if (insideData) blocks.push('ARCHIVE_INSIDE_DATA');
    if (!record) blocks.push('NOT_INSTALLED');
    const warnings = [];
    if (!view.fingerprintMatches) warnings.push('SCHEMA_CHANGED');
    if (manifest.quiesced === false) warnings.push('TAKEN_WHILE_RUNNING');
    return {
        dir: resolved,
        ...view,
        quiesced: manifest.quiesced === undefined ? null : manifest.quiesced === true,
        integrity,
        target: {
            engine,
            installationRecorded: Boolean(record),
            dataRootMatches: record && record.roots && record.roots.data ? path.resolve(record.roots.data) === path.resolve(settings.dataDir) : null
        },
        restorable: blocks.length === 0,
        blocks,
        warnings,
        schemaChangeNeedsAcceptance: !view.fingerprintMatches
    };
}

function restoreView(doc) {
    if (!doc) return null;
    const sub = {};
    for (const [name, entry] of Object.entries(doc.mutate || {})) {
        sub[name] = { done: entry.done === true, at: entry.at || null, ...(entry.restored !== undefined ? { restored: entry.restored } : {}) };
    }
    const retained = [];
    for (const [name, entry] of Object.entries(doc.mutate || {})) {
        for (const location of entry.setAside || []) {
            retained.push({ kind: name === 'database' ? 'database' : name === 'config' ? 'config' : 'files', id: name.startsWith('files:') ? name.slice('files:'.length) : name, path: location });
        }
    }
    const safety = doc.steps && doc.steps.backup;
    if (safety && safety.dir) retained.push({ kind: 'safety-backup', id: safety.archive, path: safety.dir });
    return {
        id: doc.id,
        status: doc.status,
        archive: doc.archive,
        archiveCreatedAt: doc.archiveCreatedAt,
        engine: doc.engine,
        schemaChanged: Boolean(doc.schemaChanged),
        startedAt: doc.startedAt,
        completedAt: doc.completedAt || null,
        resumes: doc.resumes || 0,
        steps: Object.fromEntries(Object.entries(doc.steps || {}).map(([name, entry]) => [name, { done: entry.done === true, at: entry.at || null }])),
        mutate: sub,
        failure: doc.failure || null,
        retained,
        result: doc.result || null,
        advice: doc.status === 'failed'
            ? 'The restore stopped part way. Nothing was rolled back: what it replaced is kept aside (see retained) and the maintenance barrier is still held. Run the same restore again to carry on, or release the barrier and restore the set-aside material by hand.'
            : null
    };
}

function backupStatus({ settings, fs = nodeFs }) {
    const record = readRecord(settings, fs);
    const state = createRestoreState({ storeDir: settings.storeDir, fs });
    const { doc, problem } = state.read();
    return {
        engine: targetEngine(settings),
        installation: { recorded: Boolean(record), installationId: record ? record.installationId : null },
        suggestedDir: backupPaths.suggestDestination(settings, record),
        restore: restoreView(doc),
        restoreProblem: problem
    };
}

module.exports = { inspectArchive, backupStatus, restoreView };
