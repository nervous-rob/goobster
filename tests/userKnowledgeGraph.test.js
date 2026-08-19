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
