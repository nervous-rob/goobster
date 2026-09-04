/**
 * Postgres schema bootstrap: strip CREATE TABLE REFERENCES and reattach
 * them as ALTER TABLE constraints so bootstrap is not exception-driven.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
    splitStatements,
    extractCreateTableForeignKeys,
    foreignKeyAlterSql,
    translateDdl
} = require('@goobster/core/db/dialect');

const SCHEMA = fs.readFileSync(
    path.join(__dirname, '../packages/core/db/schema.sql'),
    'utf8'
);

describe('extractCreateTableForeignKeys', () => {
    test('strips a forward FK and records the target', () => {
        const { sql, fks } = extractCreateTableForeignKeys(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                activeConversationId INTEGER REFERENCES conversations(id),
                username TEXT NOT NULL
            )
        `);
        expect(sql).not.toMatch(/\bREFERENCES\b/i);
        expect(sql).toMatch(/activeConversationId INTEGER/);
        expect(fks).toEqual([{
            table: 'users',
            column: 'activeConversationId',
            refTable: 'conversations',
            refColumn: 'id',
            onDelete: ''
        }]);
    });

    test('strips INTEGER PRIMARY KEY REFERENCES', () => {
        const { sql, fks } = extractCreateTableForeignKeys(`
            CREATE TABLE kg_node_embeddings (
                nodeId INTEGER PRIMARY KEY REFERENCES kg_nodes(id) ON DELETE CASCADE,
                dims INTEGER
            )
        `);
        expect(sql).not.toMatch(/\bREFERENCES\b/i);
        expect(sql).toMatch(/nodeId INTEGER PRIMARY KEY/);
        expect(fks).toEqual([{
            table: 'kg_node_embeddings',
            column: 'nodeId',
            refTable: 'kg_nodes',
            refColumn: 'id',
            onDelete: 'ON DELETE CASCADE'
        }]);
    });

    test('keeps ON DELETE actions', () => {
        const { sql, fks } = extractCreateTableForeignKeys(`
            CREATE TABLE kg_edges (
                sourceId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
                targetId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE SET NULL
            )
        `);
        expect(sql).not.toMatch(/\bREFERENCES\b|ON DELETE/i);
        expect(fks.map(fk => fk.onDelete)).toEqual(['ON DELETE CASCADE', 'ON DELETE SET NULL']);
        expect(foreignKeyAlterSql(fks[0])).toContain('ON DELETE CASCADE');
        expect(translateDdl(foreignKeyAlterSql(fks[1]))).toMatch(/ON DELETE SET NULL/i);
    });

    test('schema.sql has no leftover REFERENCES after the strip pass', () => {
        const leftover = [];
        let extracted = 0;
        for (const statement of splitStatements(SCHEMA)) {
            if (!/^\s*CREATE\s+TABLE\b/i.test(statement)) continue;
            const { sql, fks } = extractCreateTableForeignKeys(statement);
            extracted += fks.length;
            if (/\bREFERENCES\b/i.test(sql)) leftover.push(sql.slice(0, 120));
        }
        expect(leftover).toEqual([]);
        expect(extracted).toBeGreaterThan(40);
        const declared = [...SCHEMA.matchAll(/\bREFERENCES\b/gi)].length;
        expect(extracted).toBe(declared);
    });
});
