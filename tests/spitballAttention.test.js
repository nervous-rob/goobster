/**
 * The research attention generator (spec: documentation/spitball_expeditions.md
 * §34, attention pipeline in services/attentionService.js): Spitball
 * Expedition outcomes become deterministic attention candidates read from
 * durable rows - a failure is always news, a completion only when it carries
 * source-backed conflicts or a high-value Lead, and never merely "job done".
 * The research category boundary gates the whole thing.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-spitball-attention-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/aiService', () => ({
    generateText: jest.fn()
}));
jest.mock('@goobster/core/utils/chatHandler', () => ({
    handleChatInteraction: jest.fn()
}));

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const attention = require('@goobster/core/services/attentionService');
const policies = require('@goobster/core/services/attentionPolicyService');

const USER = '920000000000000001';

function fakeGateway() {
    return {
        isGoobsterGateway: true,
        sendDm: jest.fn(async () => ({ ok: true, channelId: 'dm-1', messageId: 'm-1' }))
    };
}

/** Triage answer that keeps every candidate it was shown. */
function keepAll() {
    return async (prompt) => {
        const keys = [...prompt.matchAll(/\[key: ([^\]]+)\]/g)].map(m => m[1]);
        return JSON.stringify({
            keep: keys.map(key => ({ key, adjust: 0, reason: 'worth it' })),
            drop: [],
            message: 'Research news.'
        });
    };
}

/** A terminal expedition row + one completed cycle with the given outcome. */
async function seedExpedition({
    seed = 'positive Grassmannian',
    status = 'COMPLETED',
    stopReason = 'MAX_CYCLES',
    lastError = null,
    notesCreated = 8,
    edgesCreated = 5,
    conflictsFound = 0,
    leads = []
} = {}) {
    const id = await db.insert(
        `INSERT INTO spitball_expeditions
            (userId, guildId, scopeKey, seed, lensId, depth, status, maxCycles, maxSources, maxNotes,
             currentCycle, notesCreated, edgesCreated, stopReason, lastError, finishedAt)
         VALUES
            (@userId, @guildId, @scopeKey, @seed, 'general', 'standard', @status, 3, 25, 60,
             1, @notesCreated, @edgesCreated, @stopReason, @lastError, datetime('now'))`,
        {
            userId: USER, guildId: `dm:${USER}`, scopeKey: `USER:${USER}`,
            seed, status, stopReason, lastError, notesCreated, edgesCreated
        }
    );
    await db.insert(
        `INSERT INTO spitball_expedition_cycles
            (expeditionId, cycleNumber, status, notesCreated, edgesCreated, conflictsFound,
             frontierOutputJson, finishedAt)
         VALUES
            (@expeditionId, 1, @cycleStatus, @notesCreated, @edgesCreated, @conflictsFound,
             @leads, datetime('now'))`,
        {
            expeditionId: id,
            cycleStatus: status === 'FAILED' ? 'FAILED' : 'COMPLETED',
            notesCreated, edgesCreated, conflictsFound,
            leads: JSON.stringify(leads)
        }
    );
    return id;
}

async function sweep() {
    aiService.generateText.mockImplementation(keepAll());
    const policy = await policies.get(USER);
    return await attention.sweepUser({ policy, gateway: fakeGateway() });
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    jest.clearAllMocks();
    for (const table of [
        'attention_feedback', 'attention_notices', 'attention_provenance',
        'attention_items', 'attention_watches', 'attention_state',
        'attention_policies', 'spitball_expedition_cycles', 'spitball_expeditions'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    // observe = inbox only, never contact - what matters here is whether a
    // candidate exists at all, not how loudly it lands.
    await policies.setInitiative(USER, 'observe');
});

test('the generator is registered', () => {
    expect(attention.listGenerators().some(g => g.name === 'research_outcome')).toBe(true);
});

test('a completion with a high-value Lead becomes a deterministic candidate', async () => {
    const id = await seedExpedition({
        leads: [{ topic: 'positroid stratification', reason: 'central mechanism', expectedValue: 0.9 }]
    });
    const summary = await sweep();
    const notice = summary.notices.find(n => n.key === `research.expedition:${id}:COMPLETED`);
    expect(notice).toBeTruthy();
    expect(notice.title).toContain('strong lead');
    expect(notice.detail).toContain('positroid stratification');
    expect(notice.category).toBe('research');
});

test('an ordinary completion is NOT surfaced (never merely "job done")', async () => {
    const id = await seedExpedition({
        leads: [{ topic: 'minor aside', expectedValue: 0.3 }]
    });
    const summary = await sweep();
    expect(summary.notices.some(n => String(n.key).startsWith(`research.expedition:${id}`))).toBe(false);
});

test('source-backed conflicts are surfaced', async () => {
    const id = await seedExpedition({ conflictsFound: 2, leads: [] });
    const summary = await sweep();
    const notice = summary.notices.find(n => n.key === `research.expedition:${id}:COMPLETED`);
    expect(notice).toBeTruthy();
    expect(notice.title).toContain('conflicting evidence');
    expect(notice.detail).toContain('2 source-backed conflicts');
});

test('a failed expedition is always news, with the error attached', async () => {
    const id = await seedExpedition({
        status: 'FAILED', stopReason: 'FAILED', lastError: 'search provider exploded',
        notesCreated: 0, edgesCreated: 0
    });
    const summary = await sweep();
    const notice = summary.notices.find(n => n.key === `research.expedition:${id}:FAILED`);
    expect(notice).toBeTruthy();
    expect(notice.title).toContain('Research stalled');
    expect(notice.detail).toContain('search provider exploded');
});

test('the same outcome is never raised twice (dedupe by key)', async () => {
    await seedExpedition({ conflictsFound: 1 });
    const first = await sweep();
    expect(first.raised).toBeGreaterThan(0);
    const second = await sweep();
    expect(second.raised).toBe(0);
});

test('the research boundary gates the generator (proactiveRead off = silence)', async () => {
    await policies.setBoundary({ userId: USER, category: 'research', proactiveRead: false });
    await seedExpedition({ conflictsFound: 3 });
    const summary = await sweep();
    expect(summary.notices.some(n => n.category === 'research')).toBe(false);
});

test('old outcomes age out of the lookback window', async () => {
    const id = await seedExpedition({ conflictsFound: 1 });
    await db.run(
        `UPDATE spitball_expeditions SET finishedAt = datetime('now', '-10 days') WHERE id = @id`,
        { id }
    );
    const summary = await sweep();
    expect(summary.notices.some(n => String(n.key).startsWith(`research.expedition:${id}`))).toBe(false);
});
