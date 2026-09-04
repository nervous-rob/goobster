/**
 * Personalized new-chat suggestions (services/webSuggestionService.js):
 * lazy daily refresh, cache-first reads that never block on the model,
 * deterministic legalization of AI output, graceful degradation for
 * contextless users, and /forget-me coverage. Throwaway SQLite DB,
 * AI mocked (no network).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-web-suggestions-${process.pid}.sqlite`);

const mockAi = {
    chat: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: () => false
};
jest.mock('@goobster/core/services/aiService', () => mockAi);

const db = require('@goobster/core/db');
const service = require('@goobster/core/services/webSuggestionService');
const { legalizeSuggestions } = require('@goobster/core/services/webSuggestionService');

const USER = '700000000000000001';
const OTHER = '700000000000000002';

async function seedConversation(userId, title, id) {
    await db.run(
        `INSERT INTO web_conversations (userId, channelId, title)
         VALUES (@userId, @channelId, @title)`,
        { userId, channelId: `web:${userId}:${id}`, title }
    );
}

beforeEach(async () => {
    for (const table of ['web_suggested_queries', 'web_conversations', 'attention_items']) {
        await db.run(`DELETE FROM ${table}`);
    }
    mockAi.generateText.mockReset();
    mockAi.generateText.mockResolvedValue(JSON.stringify({
        suggestions: [
            'Show me how the neuro-lab ingest went overnight',
            'What do you remember about my thesis deadline?',
            'Chart the last week of exchange trades'
        ]
    }));
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.GOOBSTER_DB_PATH + suffix); } catch { /* gone */ }
    }
});

describe('legalizeSuggestions', () => {
    test('trims, dedupes case-insensitively, drops oversized, caps at six', () => {
        const out = legalizeSuggestions({
            suggestions: [
                '  Show me my projects  ',
                'show me my projects',
                'x'.repeat(200),
                '', null, 42,
                'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'
            ]
        });
        expect(out).toEqual(['Show me my projects', 'One', 'Two', 'Three', 'Four', 'Five']);
    });

    test('handles a bare array and garbage', () => {
        expect(legalizeSuggestions(['a good one'])).toEqual(['a good one']);
        expect(legalizeSuggestions(null)).toEqual([]);
        expect(legalizeSuggestions({ suggestions: 'not an array' })).toEqual([]);
    });
});

describe('refresh and caching', () => {
    test('a contextless user gets nothing and no model call', async () => {
        const result = await service.refreshUser(USER);
        expect(result).toBeNull();
        expect(mockAi.generateText).not.toHaveBeenCalled();
        expect(await service.countUser(USER)).toBe(0);
    });

    test('context produces stored, legalized suggestions', async () => {
        await seedConversation(USER, 'Planning the aquarium build', 1);
        const result = await service.refreshUser(USER);
        expect(result).toHaveLength(3);
        expect(mockAi.generateText).toHaveBeenCalledTimes(1);
        const prompt = mockAi.generateText.mock.calls[0][0];
        expect(prompt).toContain('Planning the aquarium build');

        const { suggestions, generatedAt } = await service.getSuggestions({ userId: USER });
        expect(suggestions).toEqual(result);
        expect(generatedAt).toBeTruthy();
    });

    test('a fresh cache is served without regenerating', async () => {
        await seedConversation(USER, 'Planning the aquarium build', 1);
        await service.refreshUser(USER);
        mockAi.generateText.mockClear();

        const { suggestions } = await service.getSuggestions({ userId: USER });
        expect(suggestions).toHaveLength(3);
        expect(mockAi.generateText).not.toHaveBeenCalled();
    });

    test('a stale cache is served as-is while the background refresh replaces it', async () => {
        await seedConversation(USER, 'Planning the aquarium build', 1);
        await service.refreshUser(USER);
        await db.run(
            `UPDATE web_suggested_queries SET generatedAt = datetime('now', '-2 days')
             WHERE userId = @userId`,
            { userId: USER }
        );
        mockAi.generateText.mockClear();
        mockAi.generateText.mockResolvedValue(JSON.stringify({
            suggestions: ['A brand new idea for today']
        }));

        const first = await service.getSuggestions({ userId: USER });
        expect(first.suggestions).toHaveLength(3); // stale served immediately
        await service._lastRefresh;                 // background refresh lands
        expect(mockAi.generateText).toHaveBeenCalledTimes(1);

        const second = await service.getSuggestions({ userId: USER });
        expect(second.suggestions).toEqual(['A brand new idea for today']);
    });

    test('a missing cache returns null defaults and refreshes in the background', async () => {
        await seedConversation(USER, 'Planning the aquarium build', 1);
        const first = await service.getSuggestions({ userId: USER });
        expect(first.suggestions).toBeNull();
        await service._lastRefresh;
        const second = await service.getSuggestions({ userId: USER });
        expect(second.suggestions).toHaveLength(3);
    });

    test('unusable model output stores nothing and keeps the old cache', async () => {
        await seedConversation(USER, 'Planning the aquarium build', 1);
        await service.refreshUser(USER);
        mockAi.generateText.mockResolvedValue('I refuse to answer in JSON');
        expect(await service.refreshUser(USER)).toBeNull();
        const { suggestions } = await service.getSuggestions({ userId: USER });
        expect(suggestions).toHaveLength(3); // previous good cache survives
    });

    test('a model failure degrades to null, never a throw from the read path', async () => {
        await seedConversation(USER, 'Planning the aquarium build', 1);
        mockAi.generateText.mockRejectedValue(new Error('provider down'));
        const result = await service.getSuggestions({ userId: USER });
        expect(result.suggestions).toBeNull();
        await service._lastRefresh; // the failed background refresh is swallowed
        expect(await service.countUser(USER)).toBe(0);
    });

    test('concurrent refreshes collapse into one model call', async () => {
        await seedConversation(USER, 'Planning the aquarium build', 1);
        await Promise.all([service.refreshUser(USER), service.refreshUser(USER)]);
        expect(mockAi.generateText).toHaveBeenCalledTimes(1);
    });
});

describe('erasure', () => {
    test('forgetUser deletes the row and leaves other users alone', async () => {
        await seedConversation(USER, 'Mine', 1);
        await seedConversation(OTHER, 'Theirs', 2);
        await service.refreshUser(USER);
        await service.refreshUser(OTHER);
        expect(await service.countUser(USER)).toBe(1);

        expect(await service.forgetUser(USER)).toBe(1);
        expect(await service.countUser(USER)).toBe(0);
        expect(await service.countUser(OTHER)).toBe(1);
    });
});
