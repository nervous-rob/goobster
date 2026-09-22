/**
 * Saved-knowledge curation contract (ADR 0008,
 * documentation/knowledge_and_memory.md): intent is a column apart from
 * provenance, Notes/Map/search share one server-side projection, the
 * backfill is conservative, and deleting a note is distinct from deleting
 * a memory. Runs on SQLite and Postgres through the db facade.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-curation-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const kg = require('@goobster/core/services/knowledgeGraphService');
const kgConfig = require('@goobster/core/config/knowledgeGraphConfig');
const factsService = require('@goobster/core/services/factsService');
const memoryService = require('@goobster/core/services/memoryService');
const privacyService = require('@goobster/core/services/privacyService');
const webDashboardService = require('@goobster/core/services/webDashboardService');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const USER = '910000000000000001';
const SCOPE = dmScopeId(USER);
const SCOPE_KEY = `USER:${USER}`;

const fakeClient = { guilds: { cache: new Map() } };

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM kg_provenance');
    await db.run('DELETE FROM kg_node_revisions');
    await db.run('DELETE FROM kg_node_tags');
    await db.run('DELETE FROM kg_tags');
    await db.run('DELETE FROM kg_edges');
    await db.run('DELETE FROM kg_artifacts');
    await db.run('DELETE FROM kg_nodes');
    await db.run('DELETE FROM facts');
    await db.run('DELETE FROM memory_embeddings');
    // The once-per-process backfill guard is transient state; each test
    // starts from a scope the process has not seen.
    kg._curationBackfilled.clear();
});

/** Insert a row the way pre-E2 code left it: no declared intent. */
async function legacyNode({ label, source = 'tool', type = 'concept', content = null }) {
    const id = await db.insert(
        `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content, source, curation, subjectType, subjectId)
         VALUES (@guildId, @scopeKey, @type, @label, @content, @source, 'unclassified', 'USER', @userId)`,
        { guildId: SCOPE, scopeKey: SCOPE_KEY, type, label, content: content || `${label} body`, source, userId: USER }
    );
    return Number(id);
}

async function curationOf(id) {
    return (await db.get('SELECT curation, source FROM kg_nodes WHERE id = @id', { id }));
}

describe('writers declare intent at creation', () => {
    test('the Notes editor saves; a fact mirror is memory; a saved file is saved', async () => {
        const note = await kg.createUserNote({ guildId: SCOPE, userId: USER, label: 'Sourdough starter', content: 'Feed daily' });
        expect(note.curation).toBe('saved');

        await factsService.addFact({ guildId: SCOPE, subjectType: 'USER', subjectId: USER, content: 'Bakes on Sundays', source: 'user' });
        const fact = await db.get(
            `SELECT curation, source, type FROM kg_nodes WHERE guildId = @g AND scopeKey = @s AND type = 'fact'`,
            { g: SCOPE, s: SCOPE_KEY }
        );
        expect(fact).toMatchObject({ curation: 'memory', source: 'user' });
    });

    test('the legalizer derives intent from the declared source', async () => {
        await kg.applyMutations({
            guildId: SCOPE, scopeKey: SCOPE_KEY, subjectType: 'USER', subjectId: USER,
            source: 'research', limits: kgConfig.LIMITS.research,
            provenance: { sourceKind: 'expedition', sourceId: 1 },
            mutations: { upsert: [{ type: 'concept', label: 'Positroid cells', content: 'Research output' }] }
        });
        await kg.applyMutations({
            guildId: SCOPE, scopeKey: SCOPE_KEY, subjectType: 'USER', subjectId: USER,
            source: 'consolidation',
            mutations: { upsert: [{ type: 'experience', label: 'Talked about the Pi', content: 'Distilled', memoryIds: [] }] }
        });
        await kg.applyMutations({
            guildId: SCOPE, scopeKey: SCOPE_KEY, subjectType: 'USER', subjectId: USER,
            source: 'monologue', limits: kgConfig.LIMITS.monologue,
            mutations: { upsert: [{ type: 'concept', label: 'Undeclared thought', content: 'No intent' }] }
        });
        const rows = await db.all(
            'SELECT label, curation FROM kg_nodes WHERE guildId = @g AND scopeKey = @s ORDER BY label',
            { g: SCOPE, s: SCOPE_KEY }
        );
        expect(Object.fromEntries(rows.map(r => [r.label, r.curation]))).toEqual({
            'Positroid cells': 'saved',
            'Talked about the Pi': 'memory',
            'Undeclared thought': 'unclassified'
        });
    });

    test('an automated content write never reclassifies; a human edit makes it saved', async () => {
        await kg.applyMutations({
            guildId: SCOPE, scopeKey: SCOPE_KEY, subjectType: 'USER', subjectId: USER,
            source: 'consolidation',
            mutations: { upsert: [{ type: 'concept', label: 'Espresso', content: 'Likes a double shot' }] }
        });
        const node = await kg.getNode(SCOPE, 'Espresso', SCOPE_KEY);
        expect(node.curation).toBe('memory');

        // Research touching a distilled note rewrites content, not intent.
        await kg.applyMutations({
            guildId: SCOPE, scopeKey: SCOPE_KEY, subjectType: 'USER', subjectId: USER,
            source: 'research', limits: kgConfig.LIMITS.research,
            mutations: { upsert: [{ type: 'concept', label: 'Espresso', content: 'Prefers ristretto, research says' }] }
        });
        expect((await curationOf(node.id))).toMatchObject({ curation: 'memory', source: 'research' });

        const edited = await kg.updateUserNote({ guildId: SCOPE, userId: USER, nodeId: node.id, content: 'Actually, a lungo' });
        expect(edited).toMatchObject({ curation: 'saved', source: 'user' });
    });

    test('setUserNoteCuration changes intent only - no source rebrand, no revision, no timestamp bump', async () => {
        const id = await legacyNode({ label: 'Old tool note', source: 'tool' });
        const before = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id });
        const revisionsBefore = (await kg.listNodeRevisions(id)).length;

        const kept = await kg.setUserNoteCuration({ guildId: SCOPE, userId: USER, nodeId: id, curation: 'saved' });
        expect(kept.curation).toBe('saved');
        const after = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id });
        expect(after.source).toBe('tool');
        expect(after.updatedAt).toBe(before.updatedAt);
        expect((await kg.listNodeRevisions(id)).length).toBe(revisionsBefore);

        const demoted = await kg.setUserNoteCuration({ guildId: SCOPE, userId: USER, nodeId: id, curation: 'memory' });
        expect(demoted.curation).toBe('memory');

        await expect(kg.setUserNoteCuration({ guildId: SCOPE, userId: USER, nodeId: id, curation: 'unclassified' }))
            .rejects.toMatchObject({ status: 400 });
        expect(await kg.setUserNoteCuration({ guildId: SCOPE, userId: USER, nodeId: 999999, curation: 'saved' })).toBeNull();
    });

    test('a reflection merge keeps a deliberate save', async () => {
        await kg.createUserNote({ guildId: SCOPE, userId: USER, label: 'Kept note', content: 'Mine' });
        await kg.applyMutations({
            guildId: SCOPE, scopeKey: SCOPE_KEY, subjectType: 'USER', subjectId: USER,
            source: 'consolidation',
            mutations: { upsert: [{ type: 'concept', label: 'Distilled twin', content: 'His' }] }
        });
        expect(await kg.mergeNodes({ guildId: SCOPE, scopeKey: SCOPE_KEY, keepLabel: 'Distilled twin', dropLabel: 'Kept note' })).toBe(true);
        const kept = await kg.getNode(SCOPE, 'Distilled twin', SCOPE_KEY);
        expect(kept.curation).toBe('saved');
    });
});

describe('one server-side projection', () => {
    async function seedMixedScope() {
        const saved = await kg.createUserNote({ guildId: SCOPE, userId: USER, label: 'Saved note', content: 'kept', tags: ['shared-tag'] });
        await factsService.addFact({ guildId: SCOPE, subjectType: 'USER', subjectId: USER, content: 'Distilled fact', source: 'consolidation' });
        const legacy = await legacyNode({ label: 'Legacy tool note', source: 'tool' });
        await kg.addTagsToNode({ guildId: SCOPE, scopeKey: SCOPE_KEY, label: 'Legacy tool note', tags: ['shared-tag'] });
        const factNode = await db.get(
            `SELECT id FROM kg_nodes WHERE guildId = @g AND scopeKey = @s AND type = 'fact'`, { g: SCOPE, s: SCOPE_KEY }
        );
        await db.run('INSERT INTO kg_node_tags (nodeId, tagId) SELECT @n, id FROM kg_tags WHERE name = @t', { n: factNode.id, t: 'shared-tag' });
        return { saved, legacy, factNode };
    }

    test('Notes, Map and facet counts agree in every view; legacy rows stay visible', async () => {
        await seedMixedScope();

        const notes = await kg.listUserNotes({ guildId: SCOPE, userId: USER });
        expect(notes.view).toBe('knowledge');
        expect(notes.total).toBe(2);
        expect(notes.notes.map(n => n.label).sort()).toEqual(['Legacy tool note', 'Saved note']);
        expect(notes.curation).toEqual({ saved: 1, memory: 1, unclassified: 1 });
        // Facets count inside the projection: the shared tag is on three
        // nodes but only two are in view.
        expect(notes.tags.find(t => t.name === 'shared-tag').uses).toBe(2);
        expect(notes.types.find(t => t.type === 'fact')).toBeUndefined();
        expect(notes.curations.map(c => c.curation).sort()).toEqual(['saved', 'unclassified']);

        const map = await kg.getPersonalGraphView({ guildId: SCOPE, userId: USER });
        expect(map.counts.nodes).toBe(notes.total);
        expect(map.counts.hidden).toBe(1);
        expect(map.nodes.filter(n => n.id !== 'you').map(n => n.label).sort()).toEqual(['Legacy tool note', 'Saved note']);

        const memory = await kg.listUserNotes({ guildId: SCOPE, userId: USER, view: 'memory' });
        expect(memory.total).toBe(1);
        expect(memory.notes[0]).toMatchObject({ type: 'fact', curation: 'memory' });

        const all = await kg.listUserNotes({ guildId: SCOPE, userId: USER, view: 'all' });
        expect(all.total).toBe(3);
        expect(all.tags.find(t => t.name === 'shared-tag').uses).toBe(3);
        const allMap = await kg.getPersonalGraphView({ guildId: SCOPE, userId: USER, view: 'all' });
        expect(allMap.counts.nodes).toBe(3);
        expect(allMap.counts.hidden).toBe(0);

        const legacyOnly = await kg.listUserNotes({ guildId: SCOPE, userId: USER, view: 'all', curation: 'unclassified' });
        expect(legacyOnly.total).toBe(1);
        expect(legacyOnly.notes[0].label).toBe('Legacy tool note');

        // Search counts come from the same predicate.
        expect((await kg.listUserNotes({ guildId: SCOPE, userId: USER, q: 'fact' })).total).toBe(0);
        expect((await kg.listUserNotes({ guildId: SCOPE, userId: USER, q: 'fact', view: 'all' })).total).toBe(1);

        // Unknown views fall back to the default projection rather than leaking everything.
        expect((await kg.listUserNotes({ guildId: SCOPE, userId: USER, view: 'everything' })).total).toBe(2);
    });

    test('retrieval is not filtered by curation', async () => {
        await seedMixedScope();
        const hits = await kg.searchNodes({ guildId: SCOPE, scopeKey: SCOPE_KEY, query: 'Distilled fact', limit: 5 });
        expect(hits.some(n => n.label === 'Distilled fact')).toBe(true);
    });
});

describe('conservative backfill', () => {
    test('classifies only rows with decisive evidence and never rewrites source', async () => {
        // Legacy shapes, all unclassified as the column migration leaves them.
        const factMirror = await legacyNode({ label: 'Mirrored fact', source: 'tool', type: 'fact' });
        const factId = await db.insert(
            `INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @u, 'Mirrored fact')`,
            { g: SCOPE, u: USER }
        );
        await kg.addProvenance({ nodeId: factMirror, sourceKind: 'fact', sourceId: Number(factId) });

        const distilled = await legacyNode({ label: 'Distilled concept', source: 'consolidation' });
        const parlor = await legacyNode({ label: 'Persona note', source: 'conversation' });
        await kg.addProvenance({ nodeId: parlor, sourceKind: 'parlor_conversation', sourceId: 7 });

        const researched = await legacyNode({ label: 'Researched', source: 'research' });
        const edited = await legacyNode({ label: 'Edited by hand', source: 'consolidation' });
        await db.run(
            `INSERT INTO kg_node_revisions (nodeId, revisionNumber, label, changeKind, changedBy)
             VALUES (@id, 1, 'Edited by hand', 'human_edit', 'user')`, { id: edited }
        );
        const artifact = await legacyNode({ label: 'Saved picture', source: 'tool', type: 'artifact' });
        await db.run(
            `INSERT INTO kg_artifacts (nodeId, guildId, scopeKey, authorId, originalName, artifactKind, relativePath)
             VALUES (@id, @g, @s, @u, 'pic.png', 'image', 'x/pic.png')`,
            { id: artifact, g: SCOPE, s: SCOPE_KEY, u: USER }
        );

        const toolNoEvidence = await legacyNode({ label: 'Tool note', source: 'tool' });
        const conversationNoEvidence = await legacyNode({ label: 'Conversation note', source: 'conversation' });
        const monologue = await legacyNode({ label: 'Monologue note', source: 'monologue' });

        const inventory = await kg.inventoryCuration({ guildId: SCOPE, userId: USER });
        expect(inventory.counts).toEqual({ saved: 0, memory: 0, unclassified: 9 });
        expect(inventory.unclassified).toEqual({ total: 9, memoryEvidence: 4, savedEvidence: 3 });
        expect(inventory.bySource.find(r => r.source === 'tool')).toMatchObject({ curation: 'unclassified', count: 3 });

        const moved = await kg.backfillCuration({ guildId: SCOPE, userId: USER });
        expect(moved).toEqual({ memory: 3, saved: 3 });

        const expectations = {
            [factMirror]: ['memory', 'tool'],
            [distilled]: ['memory', 'consolidation'],
            [parlor]: ['memory', 'conversation'],
            [researched]: ['saved', 'research'],
            [edited]: ['saved', 'consolidation'],
            [artifact]: ['saved', 'tool'],
            [toolNoEvidence]: ['unclassified', 'tool'],
            [conversationNoEvidence]: ['unclassified', 'conversation'],
            [monologue]: ['unclassified', 'monologue']
        };
        for (const [id, [curation, source]] of Object.entries(expectations)) {
            expect(await curationOf(Number(id))).toEqual({ curation, source });
        }
        expect((await db.get('SELECT COUNT(*) AS c FROM kg_nodes')).c).toBe(9);

        // Once per process; a second call is a no-op and the evidence-free rows stay visible in Notes.
        expect(await kg.backfillCuration({ guildId: SCOPE, userId: USER })).toBeNull();
        const notes = await kg.listUserNotes({ guildId: SCOPE, userId: USER });
        expect(notes.notes.map(n => n.label).sort()).toEqual([
            'Conversation note', 'Edited by hand', 'Monologue note', 'Researched', 'Saved picture', 'Tool note'
        ]);
    });

    test('a scope with nothing unclassified is left alone', async () => {
        await kg.createUserNote({ guildId: SCOPE, userId: USER, label: 'Only saved', content: 'x' });
        expect(await kg.backfillCuration({ guildId: SCOPE, userId: USER })).toEqual({ memory: 0, saved: 0 });
    });
});

describe('deletion stays distinct per representation', () => {
    test('deleting a note removes its mirrored fact row but not the raw memory', async () => {
        const memoryId = await db.insert(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@g, @u, 'Rob', 'I bake sourdough on Sundays', x'00000000', 1, 'test/model')`,
            { g: SCOPE, u: USER }
        );
        await factsService.addFact({ guildId: SCOPE, subjectType: 'USER', subjectId: USER, content: 'Bakes on Sundays', source: 'consolidation' });
        const factNode = await db.get(
            `SELECT id FROM kg_nodes WHERE guildId = @g AND scopeKey = @s AND type = 'fact'`, { g: SCOPE, s: SCOPE_KEY }
        );
        await kg.addProvenance({ nodeId: factNode.id, sourceKind: 'memory', sourceId: Number(memoryId) });

        expect(await kg.deleteUserNote({ guildId: SCOPE, userId: USER, nodeId: factNode.id })).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM facts WHERE guildId = @g', { g: SCOPE })).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE id = @id', { id: memoryId })).c).toBe(1);

        // The next read must not resurrect the fact through the legacy sync.
        const all = await kg.listUserNotes({ guildId: SCOPE, userId: USER, view: 'all' });
        expect(all.total).toBe(0);
        expect((await factsService.getUserFacts(SCOPE, USER, 50)).length).toBe(0);
    });

    test('deleting a memory leaves the notes distilled from it in place', async () => {
        const memoryId = await db.insert(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@g, @u, 'Rob', 'talked about espresso', x'00000000', 1, 'test/model')`,
            { g: SCOPE, u: USER }
        );
        await kg.applyMutations({
            guildId: SCOPE, scopeKey: SCOPE_KEY, subjectType: 'USER', subjectId: USER,
            source: 'consolidation',
            mutations: { upsert: [{ type: 'concept', label: 'Espresso', content: 'Likes it', memoryIds: [Number(memoryId)] }] }
        });
        await webDashboardService.deleteMemory({ client: fakeClient, scope: SCOPE, userId: USER, memoryId: Number(memoryId) });
        expect((await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE id = @id', { id: memoryId })).c).toBe(0);
        const note = await kg.getNode(SCOPE, 'Espresso', SCOPE_KEY);
        expect(note).toBeTruthy();
        expect(note.curation).toBe('memory');
        await memoryService.cleanupVecIndex();
    });

    test('the transparency report breaks the graph down by curation and /forget-me erases all of it', async () => {
        await kg.createUserNote({ guildId: SCOPE, userId: USER, label: 'Saved', content: 'x' });
        await factsService.addFact({ guildId: SCOPE, subjectType: 'USER', subjectId: USER, content: 'Distilled', source: 'consolidation' });
        await legacyNode({ label: 'Legacy', source: 'tool' });

        const report = await privacyService.buildUserReport({ guildId: SCOPE, userId: USER });
        expect(report.knowledgeGraph).toMatchObject({ nodes: 3, saved: 1, distilled: 1, unclassified: 1 });

        await privacyService.forgetUser({ userId: USER, client: fakeClient });
        const audit = await privacyService.auditUser({ userId: USER });
        expect(audit.byTable.kg_nodes).toBe(0);
    });
});
