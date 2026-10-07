/**
 * The SQLite side of a migration: a read-only handle that pins one
 * consistent snapshot, and a hash of the files that make up the database.
 *
 * The maintenance barrier guarantees nothing writes the source while the
 * operation runs; the hash proves it. The read transaction makes one copy or
 * verify pass see a single point in time even if that guarantee were broken.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { MigrationError } = require('./errors');
const { quoteIdent } = require('./schemaModel');

const CHUNK = 1 << 20;

function openSource(sqlitePath) {
    let database;
    try {
        database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    } catch {
        throw new MigrationError('SOURCE_UNREADABLE', 'The SQLite source cannot be opened read-only.');
    }
    let pinned = false;
    return {
        database,
        tables() {
            return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
        },
        columns(table) {
            return database.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(col => col.name);
        },
        count(table) {
            return database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get().c;
        },
        rows(table, columns) {
            return database.prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}`).iterate();
        },
        all(sql, params = {}) {
            return database.prepare(sql).all(params);
        },
        get(sql, params = {}) {
            return database.prepare(sql).get(params);
        },
        /** Start the read transaction and pin the snapshot with a first read. */
        pin() {
            if (pinned) return;
            database.exec('BEGIN');
            database.prepare('SELECT COUNT(*) FROM sqlite_master').get();
            pinned = true;
        },
        close() {
            try { if (pinned) database.exec('ROLLBACK'); } catch { }
            pinned = false;
            database.close();
        }
    };
}

function hashFile(hash, file) {
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(CHUNK);
        for (;;) {
            const n = fs.readSync(fd, buffer, 0, CHUNK, null);
            if (n === 0) break;
            hash.update(n === CHUNK ? buffer : buffer.subarray(0, n));
        }
    } finally {
        fs.closeSync(fd);
    }
}

/** sha256 over the database file and its `-wal`, as one digest. */
function hashSource(sqlitePath) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for (const file of [sqlitePath, `${sqlitePath}-wal`]) {
        if (!fs.existsSync(file)) continue;
        hash.update(`${file === sqlitePath ? 'db' : 'wal'}:${fs.statSync(file).size}:`);
        hashFile(hash, file);
        bytes += fs.statSync(file).size;
    }
    return { sha256: hash.digest('hex'), bytes };
}

module.exports = { openSource, hashSource };
