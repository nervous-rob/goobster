/**
 * The schema fingerprint of a release (documentation/manager_update.md "Schema compatibility").
 *
 * sha256 over two things a release carries: the bytes of `db/schema.sql` (line endings
 * normalised) and the ordered `COLUMN_MIGRATIONS` of `db/migrations.js`. It is computed from a
 * payload directory, so the payload manifest is unchanged and a release with no schema change
 * has the same fingerprint as the one before it. Two fingerprints that differ mean the new
 * release can change the database on its first start; that is the whole rule that decides
 * whether an automatic rollback is allowed.
 *
 * `migrations.js` is read as text and evaluated in an empty context (no `require`, no
 * globals): the payload's own code is never loaded into the manager.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { ManagerError } = require('../errors');

const VERSION = 'goobster-schema-v1';
const DB_DIRS = Object.freeze([
    ['app', 'node_modules', '@goobster', 'core', 'db'],
    ['packages', 'core', 'db']
]);

function unavailable() {
    return new ManagerError(409, 'SCHEMA_FINGERPRINT_UNAVAILABLE', 'The release does not carry a readable database schema, so whether it changes the database cannot be told.');
}

function dbDirOf(payloadDir, fs) {
    for (const parts of DB_DIRS) {
        const dir = path.join(payloadDir, ...parts);
        if (fs.existsSync(path.join(dir, 'schema.sql'))) return dir;
    }
    return null;
}

function columnMigrations(text) {
    const sandbox = { module: { exports: {} } };
    vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    try {
        new vm.Script(text, { filename: 'migrations.js' }).runInContext(sandbox, { timeout: 1000 });
    } catch {
        throw unavailable();
    }
    const list = sandbox.module.exports && sandbox.module.exports.COLUMN_MIGRATIONS;
    if (!Array.isArray(list)) throw unavailable();
    return JSON.parse(JSON.stringify(list));
}

/** @returns {string} 64 hex characters */
function fingerprintOf(payloadDir, { fs = nodeFs } = {}) {
    const dir = dbDirOf(payloadDir, fs);
    if (!dir) throw unavailable();
    let schema;
    let migrations;
    try {
        schema = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8').replace(/\r\n/g, '\n');
        migrations = fs.readFileSync(path.join(dir, 'migrations.js'), 'utf8');
    } catch {
        throw unavailable();
    }
    const hash = crypto.createHash('sha256');
    hash.update(`${VERSION}\n`);
    hash.update(`schema:${crypto.createHash('sha256').update(schema).digest('hex')}\n`);
    hash.update(`migrations:${JSON.stringify(columnMigrations(migrations))}\n`);
    return hash.digest('hex');
}

/** The fingerprint of `<codeRoot>/current`, or null when it cannot be read. */
function currentFingerprint(codeRoot, { fs = nodeFs } = {}) {
    try {
        return fingerprintOf(path.join(codeRoot, 'current'), { fs });
    } catch {
        return null;
    }
}

/** Does moving from `from` to `to` change the schema? An unknown fingerprint counts as changing: the safe answer. */
function schemaChanging(from, to) {
    return !from || !to || from !== to;
}

module.exports = { VERSION, fingerprintOf, currentFingerprint, schemaChanging };
