/**
 * A seeded SQLite installation for the migration specs and the manual proof.
 *
 * `createSeededSqlite(file, { dataDir })` builds a database the way the
 * application would (schema.sql plus the column migrations) with
 * better-sqlite3 directly - the facade is a process singleton and the same
 * spec also runs with GOOBSTER_DB_URL set - then fills it:
 *
 *   1. hand-written rows for the five relationship chains verify.js checks
 *      (users <-> memories, projects <-> files, inbox <-> person, exchange
 *      positions <-> accounts, knowledge graph edges <-> nodes), with the
 *      awkward values the copy has to carry (unicode, JSON text, a REAL, a
 *      float32 BLOB, NULLs, mixed-case columns);
 *   2. one generic row for every other table, built from the schema model
 *      (NOT NULL columns, foreign keys, CHECK ... IN lists), so every
 *      current domain has at least one row.
 *
 * It also writes the files the path-bearing columns point at under the data
 * directory. Nothing here touches anything but the paths it is given. The
 * #335 reset work may land its own helper; the coordinator will unify.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { applySchema, expectedSchema, quoteIdent } = require('@goobster/core/db/migration/schemaModel');

const DIMS = 8;
const GUILD = '900000000000000001';
const USER = '800000000000000001';
const USER_B = '800000000000000002';

function floatBlob(seed) {
    const array = new Float32Array(DIMS);
    for (let i = 0; i < DIMS; i++) array[i] = Math.sin(seed + i) / 2;
    return Buffer.from(array.buffer);
}

function insert(database, table, row) {
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(c => `@${c}`).join(', ')})`;
    return database.prepare(sql).run(row);
}

function seedChains(database, { dataDir }) {
    const conversationId = insert(database, 'conversations', { userId: 1 }).lastInsertRowid;
    insert(database, 'users', { discordUsername: 'ada', discordId: USER, username: 'Ada Lovelace', activeConversationId: conversationId });
    insert(database, 'users', { discordUsername: 'bo', discordId: USER_B, username: 'Bø \u2728', activeConversationId: null });
    insert(database, 'messages', { conversationId, message: 'héllo wörld \u{1F44B}', isBot: 0, createdBy: 1, metadata: JSON.stringify({ tokens: 12, tags: ['a', 'b'] }) });
    insert(database, 'messages', { conversationId, message: 'second', isBot: 1, createdBy: 2, metadata: null });

    for (let i = 0; i < 12; i++) {
        insert(database, 'memory_embeddings', {
            guildId: GUILD,
            channelId: '700000000000000001',
            authorId: i % 2 ? USER : USER_B,
            authorName: i % 2 ? 'ada' : 'bo',
            content: `memory ${i} \u2014 ${'x'.repeat(i * 7)}`,
            embedding: floatBlob(i),
            dims: DIMS,
            model: 'fixture-embed',
            createdAt: `2025-01-${String(i + 1).padStart(2, '0')} 08:30:00`
        });
    }

    const projectId = insert(database, 'observatory_projects', { userId: USER, slug: 'galaxy', name: 'Galaxy merger', description: null, icon: '\u{1F30C}' }).lastInsertRowid;
    const assetId = insert(database, 'project_assets', { projectId, userId: USER, slug: 'dashboard', name: 'Dashboard', kind: 'app', grantsJson: JSON.stringify({ observatoryRead: ['other'] }) }).lastInsertRowid;
    const versionId = insert(database, 'project_asset_versions', { assetId, userId: USER, version: 1, language: 'html', source: '<h1>caf\u00e9</h1>', contentHash: 'abc123', note: null, origin: 'chat' }).lastInsertRowid;
    database.prepare('UPDATE project_assets SET currentVersionId = ? WHERE id = ?').run(versionId, assetId);
    insert(database, 'observatory_jobs', { projectId, userId: USER, language: 'python', code: 'print(1)', status: 'COMPLETED', renderPath: 'out/render.mp4' });

    insert(database, 'principals', { id: 'principal-1', displayName: 'Ada' });
    insert(database, 'inbox_items', { userId: USER, kind: 'notice', title: 'Welcome', body: 'Hello', attachmentsJson: JSON.stringify([{ url: '/x', name: 'x.png' }]), discordStatus: 'skipped' });
    insert(database, 'inbox_items', { userId: 'principal-1', kind: 'task', title: 'Do the thing', body: null, discordStatus: 'skipped' });

    insert(database, 'exchange_accounts', { guildId: GUILD, userId: USER, accountType: 'MARGIN', leverage: 2.5, goblinMode: 1, marginLoan: 1200, accruedInterest: 0.37 });
    insert(database, 'exchange_accounts', { guildId: GUILD, userId: USER_B });
    insert(database, 'short_positions', { guildId: GUILD, userId: USER, symbol: 'GOBL', units: 3.25, proceeds: 900, avgPrice: 277.5 });
    insert(database, 'option_positions', { guildId: GUILD, userId: USER, underlying: 'GOBL', optionType: 'CALL', strike: 280.5, expiry: '2026-12-18', contracts: 2, openPremium: 4.2, costBasis: 840 });

    const nodeA = insert(database, 'kg_nodes', { guildId: GUILD, scopeKey: `USER:${USER}`, label: 'Ada', content: 'Likes analytical engines', type: 'person' }).lastInsertRowid;
    const nodeB = insert(database, 'kg_nodes', { guildId: GUILD, scopeKey: `USER:${USER}`, label: 'Engines', content: null, type: 'thing' }).lastInsertRowid;
    insert(database, 'kg_edges', { guildId: GUILD, scopeKey: `USER:${USER}`, sourceId: nodeA, targetId: nodeB, relation: 'likes', relationKind: 'associative', weight: 0.8125 });

    const files = [
        ['kg-artifacts', 'a1/report.txt', 'artifact body'],
        ['sandbox/projects', `${USER}/galaxy/out/render.mp4`, 'video bytes'],
        ['web-uploads', 'u1/file.png', 'png bytes']
    ];
    for (const [dir, relative, body] of files) {
        const target = path.join(dataDir, dir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
    }
    insert(database, 'kg_artifacts', { guildId: GUILD, scopeKey: `USER:${USER}`, nodeId: nodeA, authorId: USER, originalName: 'report.txt', relativePath: 'a1/report.txt', sizeBytes: 13, contentHash: 'h', mimeType: 'text/plain' });
    insert(database, 'web_generated_files', { id: 'gen-1', userId: USER, path: path.join(dataDir, 'web-uploads', 'u1', 'file.png'), name: 'file.png' });
}

function checkValues(sql, column) {
    const out = [];
    const pattern = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, 'ig');
    for (const match of String(sql).matchAll(pattern)) {
        for (const item of match[1].split(',')) {
            const value = item.trim().replace(/^'|'$/g, '');
            if (value) out.push(value);
        }
    }
    return out;
}

function genericRow(database, table, model, ordinal) {
    const sqlRow = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    const row = {};
    for (const col of model.columns) {
        const fk = model.foreignKeys.find(item => item.column === col.name);
        if (fk) {
            const parent = database.prepare(`SELECT ${quoteIdent(fk.parentColumn || 'id')} AS v FROM ${quoteIdent(fk.parent)} LIMIT 1`).get();
            if (parent) {
                row[col.name] = parent.v;
                continue;
            }
            if (col.notNull) return null;
            continue;
        }
        const allowed = checkValues(sqlRow.sql, col.name);
        const isIdentity = col.pk > 0 && col.type === 'INTEGER' && model.primaryKey.length === 1;
        if (isIdentity) continue;
        if (col.hasDefault && !allowed.length && !col.pk) continue;
        if (!col.notNull && !col.pk && !allowed.length) continue;
        if (allowed.length) row[col.name] = allowed[0];
        else if (col.type.includes('INT')) row[col.name] = ordinal + 1;
        else if (col.type === 'REAL' || col.type.startsWith('NUM')) row[col.name] = 1.5;
        else if (col.type === 'BLOB') row[col.name] = Buffer.from([1, 2, 3, ordinal]);
        else row[col.name] = `${table}.${col.name}.${ordinal}`;
    }
    return row;
}

function fillRemaining(database) {
    const model = expectedSchema();
    const filled = [];
    const skipped = [];
    database.pragma('foreign_keys = ON');
    for (const table of model.order) {
        const count = database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get().c;
        if (count > 0) continue;
        let done = false;
        for (let ordinal = 0; ordinal < 2 && !done; ordinal++) {
            const row = genericRow(database, table, model.tables[table], ordinal + 1);
            if (!row) break;
            try {
                if (Object.keys(row).length === 0) database.prepare(`INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`).run();
                else insert(database, table, row);
                done = true;
            } catch { }
        }
        (done ? filled : skipped).push(table);
    }
    return { filled, skipped };
}

/** The three tables whose CHECK constraints the generic filler cannot satisfy. */
function seedLate(database) {
    const first = (table) => database.prepare(`SELECT id FROM ${quoteIdent(table)} ORDER BY id LIMIT 1`).get().id;
    insert(database, 'conversation_contexts', { userId: USER, inboxItemId: first('inbox_items'), webConversationId: first('web_conversations') });
    const sourceId = insert(database, 'followed_sources', { userId: USER, projectId: first('observatory_projects'), url: 'https://example.invalid/feed.xml', label: 'Feed', kind: 'feed' }).lastInsertRowid;
    insert(database, 'followed_source_entries', { sourceId, entryKey: 'e1', url: 'https://example.invalid/e1', title: 'Entry', contentHash: 'h1' });
}

/**
 * @param {string} file the SQLite file to create (must not exist)
 * @param {{ dataDir: string }} options where the referenced files are written
 * @returns {{ file: string, filled: string[], skipped: string[], tables: number, rows: number }}
 */
function createSeededSqlite(file, { dataDir }) {
    if (fs.existsSync(file)) throw new Error('refusing to seed an existing file');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const database = new Database(file);
    try {
        database.pragma('journal_mode = WAL');
        applySchema(database);
        seedChains(database, { dataDir });
        const { filled, skipped } = fillRemaining(database);
        seedLate(database);
        for (const name of ['conversation_contexts', 'followed_sources', 'followed_source_entries']) skipped.splice(skipped.indexOf(name), 1);
        const names = Object.keys(expectedSchema().tables);
        let rows = 0;
        let tables = 0;
        for (const name of names) {
            const count = database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`).get().c;
            rows += count;
            if (count > 0) tables++;
        }
        database.pragma('wal_checkpoint(TRUNCATE)');
        return { file, filled, skipped, tables, rows };
    } finally {
        database.close();
    }
}

/**
 * A connection to `schema` as a role that cannot CREATE in it. A superuser
 * bypasses privilege checks, so revoking from CURRENT_USER proves nothing
 * when the suite's role is one (CI's pgvector container bootstraps the test
 * role as the superuser); then a throwaway LOGIN role with USAGE only is
 * created and its URL returned. A plain role is just revoked. The returned
 * `cleanup` drops whatever was created, in either order with the schema.
 * @param {import('pg').Client} admin a connected client on the suite's role
 * @param {string} baseUrl the suite's connection URL without a query string
 * @param {string} schema
 * @returns {Promise<{ url: string, cleanup: () => Promise<void> }>}
 */
async function lockedSchemaUrl(admin, baseUrl, schema) {
    const me = (await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0] || {};
    const search = `?options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
    if (!me.rolsuper) {
        await admin.query(`REVOKE CREATE ON SCHEMA ${schema} FROM CURRENT_USER`);
        return { url: `${baseUrl}${search}`, cleanup: async () => { } };
    }
    const role = `${schema}_locked`;
    const password = `pw_${schema}`;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    const url = new URL(baseUrl);
    url.username = role;
    url.password = password;
    return {
        url: `${url.toString()}${search}`,
        cleanup: async () => {
            try {
                await admin.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${role}`);
                await admin.query(`DROP ROLE IF EXISTS ${role}`);
            } catch { }
        }
    };
}

module.exports = { createSeededSqlite, lockedSchemaUrl, DIMS, GUILD, USER, USER_B };
