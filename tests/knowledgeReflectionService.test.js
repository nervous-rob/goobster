/**
 * Unit tests for knowledge reflection (services/knowledgeReflectionService.js):
 * the pass framework behind the Library "Reflect" button and the scheduled
 * enrichment routine - against a throwaway SQLite database with the AI
 * provider and embeddings mocked (no network).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-reflection-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/aiService', () => ({
    generateText: jest.fn()
}));
jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    embedBatch: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    cosineSimilarity: jest.fn(() => 0)
}));

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const kg = require('@goobster/core/services/knowledgeGraphService');
const reflection = require('@goobster/core/services/knowledgeReflectionService');
const webDashboardService = require('@goobster/core/services/webDashboardService');

const GUILD = '500000000000000001';
const USER = '600000000000000001';
const SCOPE_KEY = `USER:${USER}`;

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    jest.clearAllMocks();
    await db.run('DELETE FROM kg_reflection_runs', {});
    await db.run('DELETE FROM kg_provenance', {});
    await db.run('DELETE FROM kg_edges', {});
    await db.run('DELETE FROM kg_node_tags', {});
    await db.run('DELETE FROM kg_tags', {});
    await db.run('DELETE FROM kg_nodes', {});
    await db.run('DELETE FROM memory_embeddings', {});
    await db.run('DELETE FROM facts', {});
});

async function seedMemory({ guildId = GUILD, authorId = USER, content, distilled = false }) {
    return await db.insert(
        `INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model, distilledAt)
         VALUES (@guildId, 'chan-1', @authorId, 'tester', @content, @embedding, 2, 'test-embed',
                 ${distilled ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
        { guildId, authorId, content, embedding: Buffer.alloc(8) }
    );
}

async function seedNode({ guildId = GUILD, scopeKey = SCOPE_KEY, label, content = null, type = 'fact' }) {
    return await kg.upsertNode({
        guildId,
        scopeKey,
        type,
        label,
        content,
        salience: 0.7,
        confidence: 0.8,
        source: 'consolidation'
    });
}

describe('distill pass', () => {
    test('turns undistilled memories into graph mutations with provenance and marks them distilled', async () => {
        const memId = await seedMemory({ content: 'ben is building a home observatory' });
        await seedMemory({ content: 'the mirror arrives tuesday' });

        aiService.generateText.mockResolvedValue(JSON.stringify({
            mutations: {
                upsert: [
                    {
                        type: 'experience',
                        label: 'home observatory build',
                        content: 'Ben is building a home observatory',
                        salience: 0.8,
                        confidence: 0.85,
                        tags: ['astronomy'],
                        memoryIds: [Number(memId)]
                    },
                    { type: 'event', label: 'mirror delivery', content: 'arrives Tuesday' }
                ],
                link: [{
                    source: 'mirror delivery',
                    target: 'home observatory build',
                    relation: 'part_of',
                    relationKind: 'associative',
                    weight: 0.8
                }]
            }
        }));

        const run = await reflection.runScope({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            subjectType: 'USER',
            subjectId: USER,
            passes: ['distill']
        });

        expect(run.status).toBe('completed');
        expect(run.summary.distill.nodesUpserted).toBe(2);
        expect(run.summary.distill.linksCreated).toBe(1);
        expect(run.summary.distill.memoriesDistilled).toBe(2);

        const node = await kg.getNode(GUILD, 'home observatory build', SCOPE_KEY);
        expect(node).toBeTruthy();
        const provenance = await kg.getProvenanceForNode(node.id);
        expect(provenance.some(p => p.sourceKind === 'memory' && p.sourceId === Number(memId))).toBe(true);

        const undistilled = await db.get(
            'SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @g AND distilledAt IS NULL',
            { g: GUILD }
        );
        expect(undistilled.c).toBe(0);
    });

    test('in a guild, only reviews the reflecting user\'s own memories', async () => {
        await seedMemory({ content: 'mine', authorId: USER });
        await seedMemory({ content: 'somebody else\'s memory', authorId: '700000000000000009' });
        aiService.generateText.mockResolvedValue('{"mutations":{"upsert":[]}}');

        await reflection.runScope({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            subjectType: 'USER',
            subjectId: USER,
            passes: ['distill']
        });

        const prompt = aiService.generateText.mock.calls[0][0];
        expect(prompt).toContain('mine');
        expect(prompt).not.toContain('somebody else');
    });

    test('skips the model when there is nothing to distill', async () => {
        const run = await reflection.runScope({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            subjectType: 'USER',
            subjectId: USER,
            passes: ['distill']
        });
        expect(run.status).toBe('completed');
        expect(run.summary.distill.skipped).toBeTruthy();
        expect(aiService.generateText).not.toHaveBeenCalled();
    });
});

describe('weave pass', () => {
    test('creates edges between existing nodes only and never invents new ones', async () => {
        await seedNode({ label: 'likes espresso', content: 'prefers a double shot' });
        await seedNode({ label: 'morning routine', content: 'up at 6, coffee first' });

        aiService.generateText.mockResolvedValue(JSON.stringify({
            link: [
                {
                    source: 'likes espresso',
                    target: 'morning routine',
                    relation: 'part_of',
                    relationKind: 'associative',
                    weight: 0.9
                },
                // Hallucinated endpoint: must be dropped, not created as a stub
                {
                    source: 'likes espresso',
                    target: 'made-up node',
                    relation: 'relates_to',
                    weight: 0.5
                }
            ],
            // Weave must never add nodes even if the model tries
            upsert: [{ type: 'fact', label: 'sneaky new node' }],
            tag: [{ label: 'morning routine', tags: ['habits'] }]
        }));

        const run = await reflection.runScope({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            subjectType: 'USER',
            subjectId: USER,
            passes: ['weave']
        });

        expect(run.status).toBe('completed');
        expect(run.summary.weave.linksCreated).toBe(1);
        expect(run.summary.weave.tagsApplied).toBe(1);

        expect(await kg.getNode(GUILD, 'made-up node', SCOPE_KEY)).toBeFalsy();
        expect(await kg.getNode(GUILD, 'sneaky new node', SCOPE_KEY)).toBeFalsy();

        const stats = await kg.getStats(GUILD, SCOPE_KEY);
        expect(stats).toEqual({ nodes: 2, edges: 1 });
    });

    test('skips scopes with fewer than two notes', async () => {
        await seedNode({ label: 'a lonely note' });
        const run = await reflection.runScope({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            subjectType: 'USER',
            subjectId: USER,
            passes: ['weave']
        });
        expect(run.summary.weave.skipped).toBeTruthy();
        expect(aiService.generateText).not.toHaveBeenCalled();
    });
});

describe('run lifecycle', () => {
    test('a second start on a busy scope is refused with REFLECTION_BUSY', async () => {
        await seedNode({ label: 'note one' });
        await seedNode({ label: 'note two' });

        let release;
        aiService.generateText.mockReturnValue(new Promise(resolve => { release = resolve; }));

        const { run, execution } = await reflection.startRun({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            subjectType: 'USER',
            subjectId: USER,
            passes: ['weave']
        });
        expect(run.status).toBe('running');

        await expect(reflection.startRun({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            passes: ['weave']
        })).rejects.toMatchObject({ code: 'REFLECTION_BUSY' });

        release('{}');
        const finished = await execution;
        expect(finished.status).toBe('completed');
    });

    test('a failing pass settles the run as failed with the error recorded', async () => {
        await seedMemory({ content: 'something to distill' });
        aiService.generateText.mockRejectedValue(new Error('provider exploded'));

        const run = await reflection.runScope({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            subjectType: 'USER',
            subjectId: USER,
            passes: ['distill']
        });
        expect(run.status).toBe('failed');
        expect(run.error).toContain('provider exploded');
    });

    test('unknown passes are rejected up front', async () => {
        await expect(reflection.startRun({
            guildId: GUILD,
            scopeKey: SCOPE_KEY,
            passes: ['definitely-not-a-pass']
        })).rejects.toMatchObject({ code: 'BAD_PASS' });
    });
});

describe('scheduled routine', () => {
    test('reflects on under-connected scopes and respects the cooldown', async () => {
        for (let i = 0; i < 12; i++) {
            await seedNode({ label: `unwoven note ${i}`, content: `detail ${i}` });
        }
        aiService.generateText.mockResolvedValue(JSON.stringify({
            link: [{
                source: 'unwoven note 0',
                target: 'unwoven note 1',
                relation: 'relates_to',
                relationKind: 'associative',
                weight: 0.7
            }]
        }));

        const first = await reflection.runDueScopes();
        expect(first.scopesReflected).toBe(1);

        const row = await db.get(
            `SELECT runTrigger, status FROM kg_reflection_runs
             WHERE guildId = @g AND scopeKey = @s ORDER BY id DESC LIMIT 1`,
            { g: GUILD, s: SCOPE_KEY }
        );
        expect(row).toEqual({ runTrigger: 'scheduled', status: 'completed' });

        // Same scope again inside the cooldown window: nothing is due.
        const second = await reflection.runDueScopes();
        expect(second.scopesReflected).toBe(0);
    });

    test('well-connected scopes are not due', async () => {
        for (let i = 0; i < 12; i++) {
            await seedNode({ label: `woven note ${i}` });
        }
        for (let i = 0; i < 11; i++) {
            await kg.link({
                guildId: GUILD,
                scopeKey: SCOPE_KEY,
                source: `woven note ${i}`,
                target: `woven note ${i + 1}`,
                relation: 'relates_to',
                weight: 0.7
            });
        }
        const result = await reflection.runDueScopes();
        expect(result.scopesReflected).toBe(0);
        expect(aiService.generateText).not.toHaveBeenCalled();
    });
});

describe('web dashboard access rules', () => {
    const DM_SCOPE = `dm:${USER}`;

    function fakeGateway({ member = true, manageGuild = false } = {}) {
        return {
            isGoobsterGateway: true,
            getGuildMember: async (guildId) => ({
                guild: { id: guildId, name: 'Test' },
                member: member ? { id: USER, displayName: 'Tester', permissions: [] } : null
            }),
            memberHasPermission: async () => manageGuild
        };
    }

    test('personal reflection works in the user\'s own DM scope', async () => {
        await seedMemory({ guildId: DM_SCOPE, content: 'web chat memory' });
        aiService.generateText.mockResolvedValue(JSON.stringify({
            mutations: { upsert: [{ type: 'fact', label: 'a distilled note' }] }
        }));

        const { run } = await webDashboardService.startReflection({
            gateway: null,
            scope: DM_SCOPE,
            userId: USER,
            target: 'personal'
        });
        expect(run.status).toBe('running');
        expect(run.passes).toEqual(['distill', 'weave', 'tidy']);

        // Poll like the client does until the background execution settles.
        let latest;
        for (let i = 0; i < 50; i++) {
            ({ run: latest } = await webDashboardService.getReflection({
                gateway: null,
                scope: DM_SCOPE,
                userId: USER,
                target: 'personal'
            }));
            if (latest.status !== 'running') break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(latest.status).toBe('completed');
        expect(await kg.getNode(DM_SCOPE, 'a distilled note', `USER:${USER}`)).toBeTruthy();
    });

    test('guild-graph reflection requires Manage Server', async () => {
        await expect(webDashboardService.startReflection({
            gateway: fakeGateway({ manageGuild: false }),
            scope: GUILD,
            userId: USER,
            target: 'guild'
        })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });

    test('guild-graph reflection targets the guild-wide scope without distill', async () => {
        const { run } = await webDashboardService.startReflection({
            gateway: fakeGateway({ manageGuild: true }),
            scope: GUILD,
            userId: USER,
            target: 'guild'
        });
        expect(run.passes).toEqual(['weave', 'tidy']);

        const row = await db.get(
            'SELECT scopeKey FROM kg_reflection_runs WHERE id = @id',
            { id: run.id }
        );
        expect(row.scopeKey).toBe('');
    });

    test('guild-graph reflection is refused for DM scopes', async () => {
        await expect(webDashboardService.startReflection({
            gateway: null,
            scope: DM_SCOPE,
            userId: USER,
            target: 'guild'
        })).rejects.toMatchObject({ status: 400, code: 'BAD_SCOPE' });
    });
});
