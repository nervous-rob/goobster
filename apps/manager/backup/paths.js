/**
 * Path rules for backup and restore (documentation/backup_and_restore.md).
 * Database-free: the manager plans and inspects with these before any
 * helper process opens a database.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { ManagerError } = require('../errors');
const { absolutePath } = require('../install/engine');
const { lazy } = require('../lazy');

const archive = lazy('@goobster/core/services/backupArchive');

function inside(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The file sets of this installation, resolved against its data directory and environment. */
function fileSetPaths(settings) {
    return archive.FILE_SETS.map(set => ({ id: set.id, label: set.label, path: set.resolve(settings.dataDir, settings.env) }));
}

/** Every location a backup destination or a restore source must stay out of. */
function protectedRoots(settings) {
    return [
        { name: 'the manager store', path: settings.storeDir },
        ...fileSetPaths(settings).map(set => ({ name: set.label, path: set.path }))
    ];
}

/** An absolute directory path from the input, normalised. */
function parseDirectory(value, name) {
    return absolutePath(value, name);
}

/**
 * Where a backup may be written: not inside the manager store and not
 * inside any directory the archive copies (the archive would contain itself).
 */
function assertDestination(settings, dir) {
    for (const root of protectedRoots(settings)) {
        if (inside(root.path, dir)) {
            throw new ManagerError(409, 'BACKUP_DESTINATION_UNSAFE', `The backup destination lies inside ${root.name}; choose a directory outside it.`);
        }
    }
}

/**
 * Where a restore may read from: a restore replaces the file sets, so an
 * archive stored inside one would be moved aside with it.
 */
function assertSource(settings, dir) {
    for (const root of protectedRoots(settings)) {
        if (inside(root.path, dir)) {
            throw new ManagerError(409, 'ARCHIVE_INSIDE_DATA', `The archive lies inside ${root.name}, which a restore replaces; move it elsewhere first.`);
        }
    }
}

/** A folder to suggest for a backup, from the installation record's roots (or the settings). */
function suggestDestination(settings, record) {
    const data = record && record.roots && record.roots.data ? record.roots.data : settings.dataDir;
    return path.join(data, 'backups');
}

function describeDirectory(dir, fs = nodeFs) {
    try {
        const stat = fs.statSync(dir);
        return { exists: true, directory: stat.isDirectory() };
    } catch {
        return { exists: false, directory: false };
    }
}

module.exports = { inside, fileSetPaths, protectedRoots, parseDirectory, assertDestination, assertSource, suggestDestination, describeDirectory };
