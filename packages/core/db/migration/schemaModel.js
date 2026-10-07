/**
 * The schema the code expects, as data: tables, columns, primary keys and
 * foreign keys. There is no schema marker in a SQLite file (the adapter
 * applies schema.sql and the column migrations on every open), so the model
 * is built the same way - schema.sql plus the missing COLUMN_MIGRATIONS -
 * in a throwaway in-memory database. It is what the preflight compares the
 * source against, what orders the copy (parents before children) and what
 * verify walks for foreign keys.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { COLUMN_MIGRATIONS } = require('../migrations');

let cached = null;

/** Mixed-case names are quoted so Postgres keeps their case; SQLite accepts the quotes. */
function quoteIdent(name) {
    return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${String(name).replace(/"/g, '""')}"`;
}

/** Tables the migration copies: not engine internals, not the derived vector index. */
function isCopyable(name) {
    return !name.startsWith('sqlite_') && !name.startsWith('memory_vec_');
}

/** Apply schema.sql and the column migrations the file lacks to an open better-sqlite3 handle. */
function applySchema(database) {
    database.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
        const exists = database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
        if (!exists) continue;
        const columns = database.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
        if (!columns.some(item => item.name === column)) database.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${ddl}`);
    }
}

function buildExpected() {
    const database = new Database(':memory:');
    try {
        applySchema(database);
        const tables = {};
        const names = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
            .map(row => row.name).filter(isCopyable).sort();
        for (const name of names) {
            const columns = database.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all().map(col => ({
                name: col.name,
                type: String(col.type || '').toUpperCase(),
                notNull: col.notnull === 1,
                hasDefault: col.dflt_value !== null,
                pk: col.pk
            }));
            const primaryKey = columns.filter(col => col.pk > 0).sort((a, b) => a.pk - b.pk).map(col => col.name);
            const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`).all().map(fk => ({
                column: fk.from,
                parent: fk.table,
                parentColumn: fk.to
            }));
            tables[name] = { name, columns, primaryKey, foreignKeys };
        }
        return { tables, order: topologicalOrder(tables) };
    } finally {
        database.close();
    }
}

/** Parents before children; ties broken by name so the order is deterministic. */
function topologicalOrder(tables) {
    const remaining = new Map(Object.keys(tables).map(name => [
        name,
        new Set(tables[name].foreignKeys.map(fk => fk.parent).filter(parent => parent !== name && tables[parent]))
    ]));
    const order = [];
    while (remaining.size > 0) {
        const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([name]) => name).sort();
        if (ready.length === 0) {
            // A cycle cannot be ordered; copy the rest by name (no FK in the schema is deferrable today, and there is no cycle).
            order.push(...[...remaining.keys()].sort());
            break;
        }
        for (const name of ready) {
            order.push(name);
            remaining.delete(name);
            for (const deps of remaining.values()) deps.delete(name);
        }
    }
    return order;
}

function expectedSchema() {
    if (!cached) cached = buildExpected();
    return cached;
}

module.exports = { applySchema, expectedSchema, quoteIdent, isCopyable, topologicalOrder };
