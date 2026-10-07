/**
 * What is in the schema a connection names, judged against the schema this
 * release of Goobster expects (documentation/database_connection.md).
 *
 * Pure: the probe hands it the table and column names it read from the
 * catalog. There is no schema marker in a Postgres database (the adapter
 * applies `schema.sql` and the column migrations on every open), so
 * "compatible" is derived the same way the migration's preflight does: the
 * expected model from `migration/schemaModel`, compared by names.
 *
 *   missing-schema     the named schema does not exist
 *   empty              it exists and holds nothing
 *   goobster-current   every expected table and column is there, nothing else
 *   goobster-older     only Goobster tables, some table or column of this
 *                      release is missing: applying the schema (the adapter
 *                      does it on start) brings it up to date
 *   goobster-newer     a column this release does not know: written by a newer
 *                      release; never applied over
 *   foreign            a table, view or sequence that is not Goobster's
 */

const crypto = require('node:crypto');
const { expectedSchema } = require('../migration/schemaModel');

const MAX_LISTED = 20;
const DERIVED = /^memory_vec_\d+$/;

const sorted = (list) => [...list].sort().slice(0, MAX_LISTED);

function fingerprintOf(tables) {
    const hash = crypto.createHash('sha256');
    for (const name of Object.keys(tables).sort()) hash.update(`${name}(${[...tables[name]].sort().join(',')});`);
    return hash.digest('hex').slice(0, 16);
}

/** The fingerprint of the schema this release writes (stable for a given release). */
function expectedFingerprint() {
    const expected = expectedSchema();
    return fingerprintOf(Object.fromEntries(Object.entries(expected.tables).map(([name, model]) => [name, model.columns.map(col => col.name)])));
}

/**
 * @param {{ schemaExists: boolean, tables: Array<{ name: string, columns: string[] }>, otherRelations: Array<{ name: string, kind: string }> }} found
 */
function classifySchema(found) {
    const expected = expectedSchema();
    const expectedFp = expectedFingerprint();
    if (!found.schemaExists) {
        return { state: 'missing-schema', fingerprint: null, expectedFingerprint: expectedFp, tables: 0, foreign: [], missingTables: [], extraColumns: [], missingColumns: [] };
    }
    const tables = found.tables || [];
    const others = found.otherRelations || [];
    const base = { expectedFingerprint: expectedFp, tables: tables.length };
    if (tables.length === 0 && others.length === 0) return { ...base, state: 'empty', fingerprint: null, foreign: [], missingTables: [], extraColumns: [], missingColumns: [] };

    const foreign = tables.filter(table => !expected.tables[table.name] && !DERIVED.test(table.name)).map(table => table.name);
    const foreignOthers = tables.length === 0 ? others.map(item => item.name) : others.filter(item => item.kind !== 'S').map(item => item.name);
    if (foreign.length > 0 || foreignOthers.length > 0) {
        return { ...base, state: 'foreign', fingerprint: null, foreign: sorted([...foreign, ...foreignOthers]), missingTables: [], extraColumns: [], missingColumns: [] };
    }
    const present = new Map(tables.filter(table => expected.tables[table.name]).map(table => [table.name, new Set(table.columns)]));
    const extraColumns = [];
    const missingColumns = [];
    for (const [name, columns] of present) {
        const known = new Set(expected.tables[name].columns.map(col => col.name));
        for (const column of columns) if (!known.has(column)) extraColumns.push(`${name}.${column}`);
        for (const column of known) if (!columns.has(column)) missingColumns.push(`${name}.${column}`);
    }
    const missingTables = Object.keys(expected.tables).filter(name => !present.has(name));
    const fingerprint = fingerprintOf(Object.fromEntries([...present].map(([name, columns]) => [name, [...columns]])));
    const state = extraColumns.length > 0
        ? 'goobster-newer'
        : (missingTables.length > 0 || missingColumns.length > 0 ? 'goobster-older' : 'goobster-current');
    return {
        ...base,
        state,
        fingerprint,
        foreign: [],
        missingTables: sorted(missingTables),
        extraColumns: sorted(extraColumns),
        missingColumns: sorted(missingColumns)
    };
}

module.exports = { classifySchema, expectedFingerprint, fingerprintOf };
