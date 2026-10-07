/**
 * Seeds one row into every table schema.sql creates, for the reset specs
 * (#335): parents before children, the smallest row each table accepts
 * (every NOT NULL column without a default, the first literal of an
 * `IN (...)` check, a real parent key for a foreign key). The values are
 * obviously synthetic text, numbers and bytes; nothing here is a secret or
 * a person's content.
 *
 * The seeder derives everything from schema.sql, so a table added later is
 * seeded automatically. A table it cannot fill by this rule is returned in
 * `failed`, and the specs assert that list is empty.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dialect = require('@goobster/core/db/dialect');

const SCHEMA = path.join(__dirname, '..', '..', 'packages', 'core', 'db', 'schema.sql');
const SKIP_ITEM = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i;

function matching(text, open) {
    let depth = 0;
    let inString = false;
    for (let index = open; index < text.length; index++) {
        const ch = text[index];
        if (inString) {
            if (ch === "'") inString = false;
            continue;
        }
        if (ch === "'") inString = true;
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return index;
    }
    return -1;
}

function splitTop(body) {
    const items = [];
    let depth = 0;
    let inString = false;
    let current = '';
    for (const ch of body) {
        if (inString) {
            current += ch;
            if (ch === "'") inString = false;
        } else if (ch === "'") {
            inString = true;
            current += ch;
        } else if (ch === '(') {
            depth++;
            current += ch;
        } else if (ch === ')') {
            depth--;
            current += ch;
        } else if (ch === ',' && depth === 0) {
            items.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) items.push(current.trim());
    return items;
}

function definitions() {
    const out = new Map();
    for (const statement of dialect.splitStatements(fs.readFileSync(SCHEMA, 'utf8'))) {
        const header = /^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([A-Za-z_]\w*)"?/i.exec(statement);
        if (!header) continue;
        const open = statement.indexOf('(');
        const items = splitTop(statement.slice(open + 1, matching(statement, open)));
        const columns = [];
        const tableChecks = [];
        const foreignKeys = new Map();
        for (const item of items) {
            if (SKIP_ITEM.test(item)) {
                const fk = /FOREIGN\s+KEY\s*\(\s*"?(\w+)"?\s*\)\s*REFERENCES\s+"?(\w+)"?\s*\(\s*"?(\w+)"?\s*\)/i.exec(item);
                if (fk) foreignKeys.set(fk[1], { table: fk[2], column: fk[3] });
                if (/^CHECK\b/i.test(item)) tableChecks.push(item);
                continue;
            }
            const match = /^"?([A-Za-z_]\w*)"?\s+([A-Za-z]+)/.exec(item);
            if (!match) continue;
            const inline = /REFERENCES\s+"?(\w+)"?\s*\(\s*"?(\w+)"?\s*\)/i.exec(item);
            if (inline) foreignKeys.set(match[1], { table: inline[1], column: inline[2] });
            columns.push({
                name: match[1],
                type: match[2].toUpperCase(),
                notNull: /\bNOT\s+NULL\b/i.test(item) || /PRIMARY\s+KEY/i.test(item),
                hasDefault: /\bDEFAULT\b/i.test(item),
                autoKey: /PRIMARY\s+KEY/i.test(item) && /^INTEGER$/i.test(match[2]),
                text: item
            });
        }
        out.set(header[1], { columns, tableChecks, foreignKeys });
    }
    return out;
}

function firstLiteral(column, tableChecks) {
    for (const source of [column.text, ...tableChecks]) {
        const found = new RegExp(`\\b${column.name}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(source);
        if (found) {
            const literal = /'([^']*)'|(-?\d+(?:\.\d+)?)/.exec(found[1]);
            if (literal) return literal[1] !== undefined ? literal[1] : Number(literal[2]);
        }
    }
    return undefined;
}

function plainValue(table, column, variant) {
    if (column.type === 'INTEGER' || column.type === 'BIGINT') return 1;
    if (column.type === 'REAL') return 1.5;
    if (column.type === 'BLOB') return Buffer.from([1, 2, 3, 4]);
    return `seed-${table}-${column.name}${variant ? `-${variant}` : ''}`.slice(0, 80);
}

/**
 * @param {{ run: Function, get: Function }} db
 * @param {string[]} order the inventory's children-first table order
 * @param {{ skip?: string[], only?: string[], variant?: string, overrides?: Object<string, Object> }} [options]
 *   overrides: per table, values (or `async (db) => value`) for named columns;
 *   variant: salts the text values, so a second pass inserts a second row;
 *   only: seed just these tables
 * @returns {Promise<{ seeded: string[], failed: Object<string, string> }>}
 */
async function seedEveryTable(db, order, { skip = [], only = null, variant = '', overrides = {} } = {}) {
    const defs = definitions();
    const seeded = [];
    const failed = {};
    for (const table of [...order].reverse()) {
        if (skip.includes(table) || (only && !only.includes(table))) continue;
        const def = defs.get(table);
        const values = {};
        let broken = null;
        for (const column of def.columns) {
            const override = overrides[table] && overrides[table][column.name];
            if (override !== undefined) {
                values[column.name] = typeof override === 'function' ? await override(db) : override;
                continue;
            }
            const fk = def.foreignKeys.get(column.name);
            if (fk) {
                const parent = await db.get(`SELECT ${fk.column} AS v FROM ${fk.table} ORDER BY ${fk.column} LIMIT 1`);
                if (parent && parent.v !== null && parent.v !== undefined) values[column.name] = parent.v;
                else if (column.notNull) broken = `${column.name}: no ${fk.table} row to point at`;
                continue;
            }
            const literal = firstLiteral(column, def.tableChecks);
            if (literal !== undefined) {
                values[column.name] = literal;
                continue;
            }
            if (column.autoKey || column.hasDefault || !column.notNull) continue;
            values[column.name] = plainValue(table, column, variant);
        }
        if (broken) {
            failed[table] = broken;
            continue;
        }
        const names = Object.keys(values);
        try {
            await db.run(
                names.length
                    ? `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(name => `@${name}`).join(', ')})`
                    : `INSERT INTO ${table} DEFAULT VALUES`,
                values
            );
            seeded.push(table);
        } catch (error) {
            failed[table] = String(error.message || error).slice(0, 120);
        }
    }
    return { seeded, failed };
}

module.exports = { seedEveryTable, definitions };
