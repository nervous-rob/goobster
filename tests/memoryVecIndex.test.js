/**
 * Memory recall through the sqlite-vec index (services/memoryService.js):
 * indexed KNN results, brute-force parity, backfill sync, and vec-index
 * hygiene after every deletion path (prune, exclusions, erasure).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-memvec-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// Deterministic 4-dim embeddings keyed by topic words, so similarity is
// controlled by the test data instead of a live embedding API.
function fakeVector(text) {
    const t = text.toLowerCase();
    const vector = Float32Array.from([
        t.includes('minecraft') ? 1 : 0,
        t.includes('movie') ? 1 : 0,
        t.includes('deploy') ? 1 : 0,
        0.05 // avoid zero vectors
    ]);
    return vector;
}

jest.mock('../services/embeddingService', () => {
    const actual = jest.requireActual('../services/embeddingService');
    return {
        embed: jest.fn(async (text) => ({ vector: fakeVector(text), model: 'test/mock' })),
        embedBatch: jest.fn(),
        getBackend: () => 'mock',
        getModelId: () => 'test/mock',
        cosineSimilarity: actual.cosineSimilarity
    };
});

const db = require('../db');
const memoryService = require('../services/memoryService');
const privacyService = require('../services/privacyService');

const GUILD = '500000000000000001';
const CHANNEL = '500000000000000002';
const USER_A = '500000000000000003';
const USER_B = '500000000000000004';

function vecIndexCount() {
    return db.get('SELECT COUNT(*) AS c FROM memory_vec_4')?.c ?? 0;
}

async function seedMemories() {
    await memoryService.remember({
        guildId: GUILD, channelId: CHANNEL, authorId: USER_A, authorName: 'Rob',
        content: 'the minecraft server ip is 10.0.0.5 btw'
    });
    await memoryService.remember({
        guildId: GUILD, channelId: CHANNEL, authorId: USER_B, authorName: 'Alice',
        content: 'we decided movie night is friday at 8pm'
    });
    await memoryService.remember({
        guildId: GUILD, channelId: CHANNEL, authorId: USER_A, authorName: 'Rob',
        content: 'remind me to deploy the new build tomorrow'
    });
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    db.run('DELETE FROM memory_embeddings');
    memoryService.cleanupVecIndex();
});

describe('sqlite-vec availability', () => {
    test('extension loads in this environment', () => {
        expect(db.vecAvailable()).toBe(true);
        expect(memoryService.isVecIndexAvailable()).toBe(true);
    });
});

describe('indexed remember/recall', () => {
    test('remember mirrors vectors into the vec index', async () => {
        await seedMemories();
        expect(db.get('SELECT COUNT(*) AS c FROM memory_embeddings').c).toBe(3);
        expect(vecIndexCount()).toBe(3);
    });

    test('recall returns topic-relevant memories via KNN', async () => {
        await seedMemories();
        const spy = jest.spyOn(memoryService, '_recallBruteForce');

        const results = await memoryService.recall({
            guildId: GUILD,
            query: 'what is the minecraft server address?'
        });

        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].content).toContain('minecraft');
        expect(results[0].similarity).toBeGreaterThan(0.9);
        // Orthogonal topics fall below the similarity threshold
        expect(results.map(r => r.content)).not.toContain('we decided movie night is friday at 8pm');
        // The indexed path answered; brute force never ran
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('recall respects excludeContents (context-window exclusion)', async () => {
        await seedMemories();
        const results = await memoryService.recall({
            guildId: GUILD,
            query: 'minecraft server',
            excludeContents: ['the minecraft server ip is 10.0.0.5 btw']
        });
        expect(results.map(r => r.content)).not.toContain('the minecraft server ip is 10.0.0.5 btw');
    });

    test('recall is scoped to the guild partition', async () => {
        await seedMemories();
        const results = await memoryService.recall({
            guildId: '999999999999999999',
            query: 'minecraft server'
        });
        expect(results).toHaveLength(0);
    });

    test('brute-force fallback returns the same top result', async () => {
        await seedMemories();
        const indexed = await memoryService.recall({ guildId: GUILD, query: 'minecraft server ip' });

        const availabilitySpy = jest.spyOn(memoryService, 'isVecIndexAvailable').mockReturnValue(false);
        const fallback = await memoryService.recall({ guildId: GUILD, query: 'minecraft server ip' });
        availabilitySpy.mockRestore();

        expect(fallback[0].content).toBe(indexed[0].content);
        expect(fallback[0].similarity).toBeCloseTo(indexed[0].similarity, 5);
    });
});

describe('vec index sync and hygiene', () => {
    test('syncVecIndex backfills rows stored without the index', async () => {
        // Simulate a database written before the vec index existed
        db.run(
            `INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model)
             VALUES (@g, @c, @u, 'Rob', 'legacy minecraft memory from before the index', @embedding, 4, 'test/mock')`,
            { g: GUILD, c: CHANNEL, u: USER_A, embedding: Buffer.from(fakeVector('minecraft').buffer) }
        );
        expect(vecIndexCount()).toBe(0);

        memoryService.syncVecIndex();
        expect(vecIndexCount()).toBe(1);

        const results = await memoryService.recall({ guildId: GUILD, query: 'minecraft' });
        expect(results[0].content).toContain('legacy minecraft memory');
    });

    test('memoryService.forgetUser leaves no orphaned vectors', async () => {
        await seedMemories();
        memoryService.forgetUser(GUILD, USER_A);
        expect(db.get('SELECT COUNT(*) AS c FROM memory_embeddings').c).toBe(1);
        expect(vecIndexCount()).toBe(1);
    });

    test('excludeChannel purges that channel from the vec index', async () => {
        await seedMemories();
        memoryService.excludeChannel(GUILD, CHANNEL);
        expect(vecIndexCount()).toBe(0);
        memoryService.includeChannel(GUILD, CHANNEL);
    });

    test('/forget-me erasure leaves no orphaned vectors', async () => {
        await seedMemories();
        privacyService.forgetUser({ userId: USER_A });

        expect(db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE authorId = @u', { u: USER_A }).c).toBe(0);
        // Vec index contains exactly the surviving memories, nothing more
        expect(vecIndexCount()).toBe(db.get('SELECT COUNT(*) AS c FROM memory_embeddings').c);
    });
});
