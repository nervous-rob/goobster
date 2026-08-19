/**
 * Upgrading an existing database to the current schema, on both engines.
 *
 * schema.sql is only half the story: it creates missing tables, while the
 * adapters reshape the ones that already exist. Those two halves have to
 * agree, and the fixtures here are the shapes real installs are upgrading
 * from - the knowledge graph before per-user scopes (`kg_nodes` with no
 * `scopeKey`) and before saved attachments (no `artifact` node type).
 *
 * Both engines are exercised regardless of which one the suite is running
 * under, because both adapters are required directly: an upgrade path that
 * only fails on the other engine's installs is the failure mode this file
 * exists to catch.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { translateDdl, splitStatements } = require('@goobster/core/db/dialect');

// The knowledge graph as first shipped: guild-wide labels, no scopes.
const PRE_SCOPE_KG = `
CREATE TABLE kg_nodes (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'concept'
        CHECK (type IN ('concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing')),
    label TEXT NOT NULL COLLATE NOCASE,
    content TEXT,
    salience REAL NOT NULL DEFAULT 0.5,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, label)
);
CREATE INDEX idx_kg_nodes_guild_salience ON kg_nodes(guildId, salience);
CREATE TABLE kg_edges (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    sourceId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    targetId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL COLLATE NOCASE,
    weight REAL NOT NULL DEFAULT 0.5,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, sourceId, targetId, relation)
);
CREATE INDEX idx_kg_edges_source ON kg_edges(sourceId);
CREATE INDEX idx_kg_edges_target ON kg_edges(targetId);
`;

// Scoped labels had landed, saved attachments had not: no 'artifact' node
// type, no 'artifact' provenance, and the child tables already exist.
const PRE_ARTIFACT_KG = `
CREATE TABLE kg_nodes (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'concept'
        CHECK (type IN ('concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing')),
    label TEXT NOT NULL COLLATE NOCASE,
    content TEXT,
    salience REAL NOT NULL DEFAULT 0.5,
    confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL DEFAULT 'monologue'
        CHECK (source IN ('monologue', 'consolidation', 'tool', 'migration', 'user')),
    subjectType TEXT CHECK (subjectType IS NULL OR subjectType IN ('USER', 'GUILD')),
    subjectId TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, scopeKey, label)
);
CREATE INDEX idx_kg_nodes_guild_salience ON kg_nodes(guildId, scopeKey, salience);
CREATE INDEX idx_kg_nodes_scope ON kg_nodes(guildId, scopeKey);
CREATE TABLE kg_edges (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT '',
    sourceId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    targetId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL COLLATE NOCASE,
    relationKind TEXT CHECK (relationKind IS NULL OR relationKind IN ('causal', 'logical', 'associative', 'temporal', 'social')),
    weight REAL NOT NULL DEFAULT 0.5,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, sourceId, targetId, relation)
);
CREATE TABLE kg_tags (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL COLLATE NOCASE,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, scopeKey, name)
);
CREATE TABLE kg_node_tags (
    nodeId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    tagId INTEGER NOT NULL REFERENCES kg_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (nodeId, tagId)
);
CREATE TABLE kg_provenance (
    id INTEGER PRIMARY KEY,
    nodeId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    sourceKind TEXT NOT NULL CHECK (sourceKind IN ('memory', 'fact', 'consolidation', 'monologue', 'tool', 'user')),
    sourceId INTEGER,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (nodeId, sourceKind, sourceId)
);
`;

describe('SQLite: upgrading an existing database', () => {
    const files = [];
    const opened = [];

    /** Write a legacy database file and return its path. */
    function seedDatabase(ddl, rows = []) {
        const file = path.join(os.tmpdir(), `goobster-upgrade-${process.pid}-${files.length}.sqlite`);
        files.push(file);
        const seed = new Database(file);
        seed.pragma('foreign_keys = ON');
        seed.exec(ddl);
        for (const row of rows) seed.prepare(row).run();
        seed.close();
        return file;
    }

    /** Open `file` through a private copy of the adapter (it caches its handle). */
    function bootstrap(file) {
        process.env.GOOBSTER_DB_PATH = file;
        let handle = null;
        jest.isolateModules(() => {
            const adapter = require('@goobster/core/db/sqliteAdapter');
            handle = adapter.getDb();
            opened.push(adapter);
        });
        return handle;
    }

    /** Column and index shape, order-insensitive (migrations append columns). */
    function shapeOf(database, table) {
        const indexes = database.pragma(`index_list(${table})`);
        return {
            columns: database.pragma(`table_info(${table})`)
                .map(c => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value} pk=${c.pk}`)
                .sort(),
            indexes: indexes
                .filter(i => !i.name.startsWith('sqlite_autoindex'))
                .map(i => i.name)
                .sort(),
            uniques: indexes
                .filter(i => i.unique)
                .map(i => database.pragma(`index_info(${i.name})`).map(c => c.name).join(','))
                .sort()
        };
    }

    afterAll(async () => {
        for (const adapter of opened) await adapter.closeConnection();
        for (const file of files) {
            for (const suffix of ['', '-wal', '-shm']) {
                fs.rmSync(`${file}${suffix}`, { force: true });
            }
        }
        delete process.env.GOOBSTER_DB_PATH;
    });

    test('a pre-scopeKey knowledge graph opens, keeps its rows, and gains scopes', () => {
        const file = seedDatabase(PRE_SCOPE_KG, [
            `INSERT INTO kg_nodes (id, guildId, type, label, content, salience)
             VALUES (1, 'g1', 'concept', 'Alpha', 'first', 0.7)`,
            `INSERT INTO kg_edges (guildId, sourceId, targetId, relation)
             VALUES ('g1', 1, 1, 'relates-to')`
        ]);

        const database = bootstrap(file);

        expect(database.prepare('SELECT guildId, scopeKey, label, content, salience, confidence, source FROM kg_nodes').all())
            .toEqual([{
                guildId: 'g1', scopeKey: '', label: 'Alpha', content: 'first',
                salience: 0.7, confidence: 0.5, source: 'monologue'
            }]);
        expect(database.prepare('SELECT scopeKey, relation, relationKind FROM kg_edges').all())
            .toEqual([{ scopeKey: '', relation: 'relates-to', relationKind: null }]);

        // The label uniqueness that scopeKey exists to relax.
        database.prepare(`INSERT INTO kg_nodes (guildId, scopeKey, type, label) VALUES ('g1', 'USER:1', 'concept', 'Alpha')`).run();
        expect(() => database
            .prepare(`INSERT INTO kg_nodes (guildId, scopeKey, type, label) VALUES ('g1', 'USER:1', 'fact', 'Alpha')`)
            .run()).toThrow(/UNIQUE/);
    });

    test('a pre-artifact knowledge graph accepts artifact nodes and provenance', () => {
        const file = seedDatabase(PRE_ARTIFACT_KG, [
            `INSERT INTO kg_nodes (id, guildId, scopeKey, type, label) VALUES (1, 'g1', 'USER:1', 'concept', 'Beta')`,
            `INSERT INTO kg_provenance (nodeId, sourceKind, sourceId) VALUES (1, 'memory', 5)`
        ]);

        const database = bootstrap(file);

        expect(database.prepare('SELECT label FROM kg_nodes').pluck().all()).toEqual(['Beta']);
        expect(database.prepare('SELECT sourceKind FROM kg_provenance').pluck().all()).toEqual(['memory']);
        database.prepare(`INSERT INTO kg_nodes (id, guildId, scopeKey, type, label) VALUES (2, 'g1', 'USER:1', 'artifact', 'notes.pdf')`).run();
        database.prepare(`INSERT INTO kg_provenance (nodeId, sourceKind, sourceId) VALUES (2, 'artifact', 1)`).run();
        expect(database.prepare('SELECT COUNT(*) FROM kg_provenance').pluck().get()).toBe(2);
    });

    test('rebuilding kg_nodes leaves every child table pointing at it', () => {
        const file = seedDatabase(PRE_ARTIFACT_KG, [
            `INSERT INTO kg_nodes (id, guildId, scopeKey, type, label) VALUES (1, 'g1', 'USER:1', 'concept', 'Beta')`,
            `INSERT INTO kg_tags (id, guildId, scopeKey, name) VALUES (1, 'g1', 'USER:1', 'projects')`,
            `INSERT INTO kg_node_tags (nodeId, tagId) VALUES (1, 1)`
        ]);

        const database = bootstrap(file);

        expect(database.prepare('SELECT nodeId, tagId FROM kg_node_tags').all()).toEqual([{ nodeId: 1, tagId: 1 }]);
        database.prepare(`INSERT INTO kg_nodes (id, guildId, scopeKey, type, label) VALUES (2, 'g1', 'USER:1', 'concept', 'Gamma')`).run();
        database.prepare('INSERT INTO kg_node_tags (nodeId, tagId) VALUES (2, 1)').run();
        database.prepare(`INSERT INTO kg_artifacts (nodeId, guildId, scopeKey, authorId, originalName, relativePath)
                          VALUES (2, 'g1', 'USER:1', 'u1', 'notes.pdf', 'kg/notes.pdf')`).run();
        expect(database.pragma('foreign_key_check')).toEqual([]);

        // Deleting a node still cascades, which a dangling reference breaks.
        database.prepare('DELETE FROM kg_nodes WHERE id = 2').run();
        expect(database.prepare('SELECT COUNT(*) FROM kg_artifacts').pluck().get()).toBe(0);
    });

    test('references left dangling by an earlier rebuild are repaired', () => {
        const file = seedDatabase(`
            ${PRE_ARTIFACT_KG}
            DROP TABLE kg_node_tags;
            CREATE TABLE kg_node_tags (
                nodeId INTEGER NOT NULL REFERENCES "kg_nodes_legacy"(id) ON DELETE CASCADE,
                tagId INTEGER NOT NULL REFERENCES kg_tags(id) ON DELETE CASCADE,
                PRIMARY KEY (nodeId, tagId)
            );
        `, [
            `INSERT INTO kg_nodes (id, guildId, scopeKey, type, label) VALUES (1, 'g1', 'USER:1', 'concept', 'Beta')`,
            `INSERT INTO kg_tags (id, guildId, scopeKey, name) VALUES (1, 'g1', 'USER:1', 'projects')`
        ]);

        const database = bootstrap(file);

        expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'kg_node_tags'").pluck().get())
            .not.toMatch(/kg_nodes_legacy/);
        database.prepare('INSERT INTO kg_node_tags (nodeId, tagId) VALUES (1, 1)').run();
        expect(database.pragma('foreign_key_check')).toEqual([]);
    });

    test('an upgraded knowledge graph has the same shape as a fresh one', () => {
        const upgraded = bootstrap(seedDatabase(PRE_SCOPE_KG));
        const fresh = bootstrap(seedDatabase(''));

        for (const table of ['kg_nodes', 'kg_edges', 'kg_tags', 'kg_node_tags', 'kg_provenance', 'kg_artifacts']) {
            expect(shapeOf(upgraded, table)).toEqual(shapeOf(fresh, table));
        }
    });

    test('reopening an upgraded database changes nothing', () => {
        const file = seedDatabase(PRE_SCOPE_KG, [
            `INSERT INTO kg_nodes (id, guildId, type, label) VALUES (1, 'g1', 'concept', 'Alpha')`
        ]);
        const first = bootstrap(file);
        const before = first.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();

        const second = bootstrap(file);
        expect(second.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
        expect(second.prepare('SELECT label FROM kg_nodes').pluck().all()).toEqual(['Alpha']);
    });
});

const describePostgres = process.env.GOOBSTER_DB_URL ? describe : describe.skip;

describePostgres('Postgres: upgrading an existing database', () => {
    const { Client } = require('pg');
    const baseUrl = process.env.GOOBSTER_DB_URL;
    const isolate = process.env.GOOBSTER_PG_TEST_ISOLATE;
    const schemas = [];
    const opened = [];

    /**
     * Create a schema holding `ddl` (translated the same way the adapter
     * translates schema.sql) and hand back an adapter bound to it. The
     * adapter's own test isolation picks a random schema name it does not
     * report until it connects, so the search_path is pinned through the
     * connection string instead.
     */
    async function seedSchema(ddl, rows = []) {
        const name = `upgrade_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
        schemas.push(name);
        const client = new Client({ connectionString: baseUrl });
        await client.connect();
        try {
            await client.query(`CREATE SCHEMA "${name}"`);
            await client.query(`SET search_path TO "${name}", public`);
            for (const ext of ['citext', 'vector']) {
                await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext} WITH SCHEMA public`).catch(() => {});
            }
            for (const statement of splitStatements(ddl)) await client.query(translateDdl(statement));
            for (const row of rows) await client.query(row);
        } finally {
            await client.end();
        }
        return name;
    }

    async function bootstrap(schemaName) {
        const url = new URL(baseUrl);
        url.searchParams.set('options', `-csearch_path=${schemaName},public`);
        process.env.GOOBSTER_DB_URL = url.toString();
        delete process.env.GOOBSTER_PG_TEST_ISOLATE;

        let adapter = null;
        jest.isolateModules(() => { adapter = require('@goobster/core/db/postgresAdapter'); });
        opened.push(adapter);
        await adapter.rawQuery('SELECT 1');
        return adapter;
    }

    afterAll(async () => {
        for (const adapter of opened) await adapter.closeConnection();
        process.env.GOOBSTER_DB_URL = baseUrl;
        if (isolate === undefined) delete process.env.GOOBSTER_PG_TEST_ISOLATE;
        else process.env.GOOBSTER_PG_TEST_ISOLATE = isolate;

        const client = new Client({ connectionString: baseUrl });
        await client.connect();
        for (const name of schemas) await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        await client.end();
    });

    test('a pre-scopeKey knowledge graph opens, keeps its rows, and gains scopes', async () => {
        const schemaName = await seedSchema(PRE_SCOPE_KG, [
            `INSERT INTO kg_nodes (id, "guildId", type, label, content, salience)
             VALUES (1, 'g1', 'concept', 'Alpha', 'first', 0.7)`
        ]);

        const adapter = await bootstrap(schemaName);

        const nodes = await adapter.rawQuery('SELECT "guildId", "scopeKey", label, salience FROM kg_nodes');
        expect(nodes.rows).toEqual([{ guildId: 'g1', scopeKey: '', label: 'Alpha', salience: 0.7 }]);

        const uniques = await adapter.rawQuery(
            `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE t.relname = 'kg_nodes' AND c.contype = 'u' AND n.nspname = current_schema()`
        );
        expect(uniques.rows.map(r => r.def)).toEqual(['UNIQUE ("guildId", "scopeKey", label)']);
    });

    test('a pre-artifact knowledge graph accepts artifact nodes and provenance', async () => {
        const schemaName = await seedSchema(PRE_ARTIFACT_KG, [
            `INSERT INTO kg_nodes (id, "guildId", "scopeKey", type, label) VALUES (1, 'g1', 'USER:1', 'concept', 'Beta')`,
            `INSERT INTO kg_provenance ("nodeId", "sourceKind", "sourceId") VALUES (1, 'memory', 5)`
        ]);

        const adapter = await bootstrap(schemaName);

        await adapter.rawQuery(
            `INSERT INTO kg_nodes (id, "guildId", "scopeKey", type, label) VALUES (2, 'g1', 'USER:1', 'artifact', 'notes.pdf')`
        );
        await adapter.rawQuery(`INSERT INTO kg_provenance ("nodeId", "sourceKind", "sourceId") VALUES (2, 'artifact', 1)`);

        const provenance = await adapter.rawQuery('SELECT "sourceKind" FROM kg_provenance ORDER BY id');
        expect(provenance.rows.map(r => r.sourceKind)).toEqual(['memory', 'artifact']);

        const artifacts = await adapter.rawQuery(
            `SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'kg_artifacts'`
        );
        expect(artifacts.rowCount).toBe(1);
    });
});
