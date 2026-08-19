/**
 * User knowledge graph consolidation (SQLite + Postgres via db facade).
 * Spec: documentation/user_knowledge_graph.md
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-ukg-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const kg = require('@goobster/core/services/knowledgeGraphService');
const factsService = require('@goobster/core/services/factsService');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const USER = '900000000000000001';
const GUILD = '900000000000000099';
const SCOPE = dmScopeId(USER);

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM kg_provenance');
    await db.run('DELETE FROM kg_node_tags');
    await db.run('DELETE FROM kg_tags');
    await db.run('DELETE FROM kg_edges');
    await db.run('DELETE FROM kg_nodes');
    await db.run('DELETE FROM facts');
    await db.run('DELETE FROM memory_embeddings');
});

describe('scoped nodes', () => {
    test('user-scoped labels are unique per user within a guild scope', async () => {
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        await kg.upsertNode({
            guildId: SCOPE,
            scopeKey,
            subjectType: 'USER',
            subjectId: USER,
            type: 'fact',
            label: 'favorite color',
            content: 'blue',
            source: 'tool'
        });
        await kg.upsertNode({
            guildId: SCOPE,
            scopeKey,
            subjectType: 'USER',
            subjectId: USER,
            label: 'Favorite Color',
            content: 'navy blue',
            source: 'tool'
        });
        expect((await db.get('SELECT COUNT(*) AS c FROM kg_nodes')).c).toBe(1);
        expect((await kg.getNode(SCOPE, 'favorite color', scopeKey)).content).toBe('navy blue');
    });

    test('guild-wide monologue nodes use empty scopeKey', async () => {
        await kg.upsertNode({ guildId: GUILD, label: 'deploy culture', type: 'concept', source: 'monologue' });
        const node = await kg.getNode(GUILD, 'deploy culture', '');
        expect(node.scopeKey).toBe('');
        expect(node.source).toBe('monologue');
    });
});

describe('facts sync', () => {
    test('addFact mirrors into kg_nodes with provenance', async () => {
        const factId = await factsService.addFact({
            guildId: SCOPE,
            subjectType: 'USER',
            subjectId: USER,
            content: 'Likes model trains',
            source: 'model'
        });
        expect(factId).toBeTruthy();

        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        const node = await db.get(
            `SELECT n.* FROM kg_nodes n
             JOIN kg_provenance p ON p.nodeId = n.id
             WHERE p.sourceKind = 'fact' AND p.sourceId = @factId`,
            { factId }
        );
        expect(node).toBeDefined();
        expect(node.scopeKey).toBe(scopeKey);
        expect(node.type).toBe('fact');
    });

    test('getUserFacts reads from the graph when nodes exist', async () => {
        await factsService.addFact({
            guildId: SCOPE,
            subjectType: 'USER',
            subjectId: USER,
            content: 'Runs a Pi cluster'
        });
        const facts = await factsService.getUserFacts(SCOPE, USER);
        expect(facts.map(f => f.content)).toContain('Runs a Pi cluster');
    });
});

describe('legalizer mutations', () => {
    test('applyMutations upserts nodes, links edges, and applies tags', async () => {
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        const applied = await kg.applyMutations({
            guildId: SCOPE,
            scopeKey,
            subjectType: 'USER',
            subjectId: USER,
            source: 'consolidation',
            mutations: {
                upsert: [{
                    type: 'fact',
                    label: 'homelab',
                    content: 'Four Raspberry Pis',
                    salience: 0.8,
                    confidence: 0.9,
                    tags: ['hardware']
                }],
                link: [{
                    source: 'homelab',
                    target: 'homelab',
                    relation: 'relates_to',
                    relationKind: 'associative',
                    weight: 0.5
                }]
            }
        });
        expect(applied.nodesUpserted).toBe(1);
        expect(await kg.getNode(SCOPE, 'homelab', scopeKey)).toBeDefined();
    });

    test('mergeNodes combines duplicate concepts', async () => {
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        await kg.upsertNode({ guildId: SCOPE, scopeKey, label: 'pi cluster', content: 'v1', salience: 0.5 });
        await kg.upsertNode({ guildId: SCOPE, scopeKey, label: 'raspberry pi', content: 'v2', salience: 0.8 });
        expect(await kg.mergeNodes({
            guildId: SCOPE, scopeKey, keepLabel: 'raspberry pi', dropLabel: 'pi cluster'
        })).toBe(true);
        expect((await db.get('SELECT COUNT(*) AS c FROM kg_nodes WHERE guildId = @g', { g: SCOPE })).c).toBe(1);
        expect((await kg.getNode(SCOPE, 'raspberry pi', scopeKey)).content).toBe('v2');
    });
});

describe('personal graph view', () => {
    test('getPersonalGraphView syncs legacy facts and returns anchor + edges', async () => {
        await db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content)
             VALUES (@scope, 'USER', @user, 'Enjoys hiking')`,
            { scope: SCOPE, user: USER }
        );
        const view = await kg.getPersonalGraphView({ guildId: SCOPE, userId: USER });
        expect(view.nodes[0].id).toBe('you');
        expect(view.nodes.some(n => n.content === 'Enjoys hiking')).toBe(true);
        expect(view.counts.nodes).toBeGreaterThan(0);
    });
});

describe('buildUserDossier', () => {
    test('formats graph excerpt for chat prompts', async () => {
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        await kg.upsertNode({
            guildId: SCOPE,
            scopeKey,
            subjectType: 'USER',
            subjectId: USER,
            type: 'fact',
            label: 'tea preference',
            content: 'Prefers Earl Grey',
            salience: 0.9
        });
        const dossier = await kg.buildUserDossier({
            guildId: SCOPE,
            userId: USER,
            userName: 'Rob',
            query: 'tea'
        });
        expect(dossier).toContain('WHAT YOU KNOW');
        expect(dossier).toContain('Earl Grey');
    });
});

describe('provenance cleanup', () => {
    test('cleanupProvenanceForMemories removes stale rows and prunes orphans', async () => {
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        const mem = await db.insert(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@guildId, @authorId, 'Rob', 'likes tea', X'00', 1, 'test-model')`,
            { guildId: SCOPE, authorId: USER }
        );
        const node = await kg.upsertNode({
            guildId: SCOPE,
            scopeKey,
            type: 'fact',
            label: 'tea',
            content: 'likes tea',
            confidence: 0.2,
            source: 'consolidation'
        });
        await kg.addProvenance({ nodeId: node.id, sourceKind: 'memory', sourceId: Number(mem) });

        await kg.cleanupProvenanceForMemories([Number(mem)]);
        expect((await db.get(
            'SELECT COUNT(*) AS c FROM kg_provenance WHERE sourceKind = @k AND sourceId = @id',
            { k: 'memory', id: Number(mem) }
        )).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM kg_nodes WHERE id = @id', { id: node.id })).c).toBe(0);
    });
});

describe('consolidation guards', () => {
    test('hasMutationWork is false for empty applied counts', () => {
        expect(kg.hasMutationWork({ nodesUpserted: 0, linksCreated: 0 })).toBe(false);
        expect(kg.hasMutationWork({ nodesUpserted: 1 })).toBe(true);
    });

    test('hasMutationPayload detects non-empty mutation arrays', () => {
        expect(kg.hasMutationPayload({ upsert: [{ label: 'x' }] })).toBe(true);
        expect(kg.hasMutationPayload({ link: [] })).toBe(false);
    });
});

describe('facts merge and mirror delete', () => {
    test('getUserFacts merges graph and legacy without duplicates', async () => {
        await db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content)
             VALUES (@scope, 'USER', @user, 'Legacy only fact')`,
            { scope: SCOPE, user: USER }
        );
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        await kg.upsertNode({
            guildId: SCOPE,
            scopeKey,
            type: 'fact',
            label: 'Graph only',
            content: 'Graph only fact',
            source: 'consolidation'
        });
        const facts = await factsService.getUserFacts(SCOPE, USER, 20);
        expect(facts.map(f => f.content)).toEqual(
            expect.arrayContaining(['Legacy only fact', 'Graph only fact'])
        );
    });

    test('deleteMirroredFact removes kg node linked by fact provenance', async () => {
        const factId = await factsService.addFact({
            guildId: SCOPE,
            subjectType: 'USER',
            subjectId: USER,
            content: 'Mirror me'
        });
        expect((await db.get('SELECT COUNT(*) AS c FROM kg_nodes')).c).toBe(1);
        await kg.deleteMirroredFact({
            factId,
            guildId: SCOPE,
            subjectType: 'USER',
            subjectId: USER
        });
        expect((await db.get('SELECT COUNT(*) AS c FROM kg_nodes')).c).toBe(0);
    });
});

describe('guild recall author scope', () => {
    const memoryService = require('@goobster/core/services/memoryService');
    const embeddingService = require('@goobster/core/services/embeddingService');

    beforeEach(async () => {
        await db.run('DELETE FROM memory_embeddings');
        jest.spyOn(embeddingService, 'embed').mockResolvedValue({
            vector: new Float32Array([1, 0, 0]),
            model: 'test-model'
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('recall filters by authorId in guild contexts', async () => {
        const vec = Buffer.from(new Float32Array([1, 0, 0]).buffer);
        await db.run(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@g, @a, 'Alice', 'alice secret', @e, 3, 'test-model')`,
            { g: GUILD, a: '111', e: vec }
        );
        await db.run(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@g, @a, 'Bob', 'bob secret', @e, 3, 'test-model')`,
            { g: GUILD, a: '222', e: vec }
        );

        const aliceOnly = await memoryService.recall({
            guildId: GUILD,
            query: 'secret',
            authorId: '111',
            limit: 5,
            minSimilarity: 0.1
        });
        expect(aliceOnly.every(m => m.content === 'alice secret')).toBe(true);
    });
});
