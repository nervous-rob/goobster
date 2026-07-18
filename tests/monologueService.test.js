/**
 * Unit tests for the internal monologue (services/monologueService.js):
 * introspection decisions, scratch pad curation, thought journaling, and the
 * chat prompt injection - against a throwaway SQLite database with the AI
 * provider and memory recall mocked (no network).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-monologue-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../services/aiService', () => ({
    generateText: jest.fn()
}));
jest.mock('../services/memoryService', () => ({
    recall: jest.fn().mockResolvedValue([]),
    isChannelExcluded: jest.fn(() => false)
}));

const db = require('../db');
const aiService = require('../services/aiService');
const memoryService = require('../services/memoryService');
const kg = require('../services/knowledgeGraphService');
const MonologueService = require('../services/monologueService');

const GUILD = '400000000000000001';
const OTHER_GUILD = '400000000000000002';

const service = new MonologueService(null);

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    memoryService.recall.mockResolvedValue([]);
    db.run('DELETE FROM monologue_thoughts', {});
    db.run('DELETE FROM monologue_scratchpad', {});
    db.run('DELETE FROM kg_edges', {});
    db.run('DELETE FROM kg_nodes', {});
});

describe('runIntrospection', () => {
    test('applies a full decision: thought, scratch pad, and graph mutations', async () => {
        aiService.generateText.mockResolvedValue(JSON.stringify({
            thought: 'The deploy chatter is heating up; Rob seems nervous about Friday.',
            scratchpad: { add: ['watch how the Friday deploy goes'] },
            graph: {
                upsert: [
                    { type: 'person', label: 'Rob', content: 'anxious about the deploy', salience: 0.8 },
                    { type: 'event', label: 'friday deploy', salience: 0.9 }
                ],
                link: [{ source: 'Rob', relation: 'worried_about', target: 'friday deploy', weight: 0.9 }]
            }
        }));

        const result = await service.runIntrospection({
            guildId: GUILD,
            guildName: 'Test Server',
            channelId: 'chan-1',
            channelName: 'general',
            transcript: 'Rob: the deploy is friday and i am scared'
        });

        expect(result.applied).toEqual({
            notesAdded: 1,
            notesRemoved: 0,
            nodesUpserted: 2,
            linksCreated: 1,
            nodesDeleted: 0
        });

        const [thought] = service.getRecentThoughts(GUILD, 1);
        expect(thought.thought).toContain('deploy chatter');
        expect(thought.channelId).toBe('chan-1');

        expect(service.getScratchpad(GUILD).map(n => n.content))
            .toEqual(['watch how the Friday deploy goes']);

        expect(kg.getNode(GUILD, 'rob').type).toBe('person');
        expect(kg.getStats(GUILD)).toEqual({ nodes: 2, edges: 1 });

        // Attribution for usage tracking is threaded through
        expect(aiService.generateText.mock.calls[0][1].usageContext).toEqual({ guildId: GUILD });
    });

    test('the introspection prompt carries scratch pad ids, past thoughts, memories, and the graph', async () => {
        service.addNote(GUILD, 'existing note');
        service.recordThought(GUILD, 'an earlier reflection');
        kg.upsertNode({ guildId: GUILD, label: 'game night', salience: 0.9 });
        memoryService.recall.mockResolvedValue([
            { content: 'we once broke prod on a friday', authorName: 'Rob', createdAt: '2026-01-01 00:00:00' }
        ]);

        aiService.generateText.mockResolvedValue('{"thought": "ok"}');
        await service.runIntrospection({ guildId: GUILD, transcript: 'hello world' });

        const prompt = aiService.generateText.mock.calls[0][0];
        const noteId = db.get('SELECT id FROM monologue_scratchpad', {}).id;
        expect(prompt).toContain(`(id ${noteId}) existing note`);
        expect(prompt).toContain('an earlier reflection');
        expect(prompt).toContain('we once broke prod on a friday');
        expect(prompt).toContain('"game night"');
        expect(prompt).toContain('PRIVATE internal monologue');
    });

    test('per-tick caps bound how much a single decision can change', async () => {
        aiService.generateText.mockResolvedValue(JSON.stringify({
            thought: 'trying to overdo it',
            scratchpad: { add: Array.from({ length: 10 }, (_, i) => `note ${i}`) },
            graph: { upsert: Array.from({ length: 12 }, (_, i) => ({ label: `node ${i}` })) }
        }));

        const { applied } = await service.runIntrospection({ guildId: GUILD, transcript: 'x' });
        expect(applied.notesAdded).toBe(4);
        expect(applied.nodesUpserted).toBe(6);
    });

    test('an unparseable response changes nothing', async () => {
        aiService.generateText.mockResolvedValue('I refuse to answer in JSON today.');
        const result = await service.runIntrospection({ guildId: GUILD, transcript: 'x' });
        expect(result).toBeNull();
        expect(service.getRecentThoughts(GUILD)).toHaveLength(0);
        expect(kg.getStats(GUILD).nodes).toBe(0);
    });

    test('scratch pad removals are guild-scoped and by id', async () => {
        const keepId = service.addNote(OTHER_GUILD, 'other guild note');
        const removeId = service.addNote(GUILD, 'stale note');

        aiService.generateText.mockResolvedValue(JSON.stringify({
            thought: 'cleaning up',
            scratchpad: { remove: [removeId, keepId] } // second id belongs to another guild
        }));
        const { applied } = await service.runIntrospection({ guildId: GUILD, transcript: 'x' });

        expect(applied.notesRemoved).toBe(1);
        expect(service.getScratchpad(GUILD)).toHaveLength(0);
        expect(service.getScratchpad(OTHER_GUILD)).toHaveLength(1);
    });
});

describe('scratch pad and journal plumbing', () => {
    test('addNote deduplicates on exact content', () => {
        const first = service.addNote(GUILD, 'remember the milk');
        const second = service.addNote(GUILD, '  remember the milk  ');
        expect(second).toBe(first);
        expect(service.getScratchpad(GUILD)).toHaveLength(1);
    });

    test('lastThoughtAt reflects the newest journal entry (restart-safe cooldown anchor)', () => {
        expect(service.lastThoughtAt(GUILD)).toBe(0);
        service.recordThought(GUILD, 'first thought');
        const at = service.lastThoughtAt(GUILD);
        expect(at).toBeGreaterThan(Date.now() - 60 * 1000);

        // A fresh instance (simulated restart) sees the same anchor
        expect(new MonologueService(null).lastThoughtAt(GUILD)).toBe(at);
    });

    test('resetGuild erases thoughts, notes, and the graph', () => {
        service.recordThought(GUILD, 'a thought');
        service.addNote(GUILD, 'a note');
        kg.link({ guildId: GUILD, source: 'a', relation: 'r', target: 'b' });

        const removed = service.resetGuild(GUILD);
        expect(removed).toEqual({ thoughts: 1, notes: 1, nodes: 2 });
        expect(service.getStats(GUILD)).toEqual({
            thoughts: 0, lastThoughtAt: null, notes: 0, graph: { nodes: 0, edges: 0 }
        });
    });
});

describe('buildChatContext', () => {
    test('returns null when the guild has no inner life yet', () => {
        expect(service.buildChatContext(GUILD, 'hello')).toBeNull();
    });

    test('bundles the latest thought, notes, and query-relevant graph nodes', () => {
        service.recordThought(GUILD, 'old thought');
        service.recordThought(GUILD, 'newest thought');
        service.addNote(GUILD, 'a working note');
        kg.upsertNode({ guildId: GUILD, label: 'deploy pipeline', content: 'fragile', salience: 0.9 });

        const block = service.buildChatContext(GUILD, 'how is the deploy pipeline?');
        expect(block).toContain('INNER LIFE');
        expect(block).toContain('newest thought');
        expect(block).not.toContain('old thought');
        expect(block).toContain('a working note');
        expect(block).toContain('deploy pipeline');
        expect(block).toContain('never quote');
    });
});
