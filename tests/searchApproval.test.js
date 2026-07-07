/**
 * Search-approval persistence (utils/aiSearchHandler.js): pending approve/deny
 * requests are stored in SQLite so buttons keep working across a bot restart.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-search-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../services/perplexityService', () => ({
    search: jest.fn().mockResolvedValue('mocked search result')
}));

const db = require('../db');
const perplexityService = require('../services/perplexityService');
const AISearchHandler = require('../utils/aiSearchHandler');

const CHANNEL = '400000000000000001';

function stubRequestInteraction() {
    return {
        channelId: CHANNEL,
        guildId: null, // no guild -> approval required by default
        channel: { send: jest.fn().mockResolvedValue(undefined) }
    };
}

function stubButtonInteraction() {
    return {
        user: { tag: 'approver#0' },
        message: { edit: jest.fn().mockResolvedValue(undefined) },
        channel: { send: jest.fn().mockResolvedValue(undefined) }
    };
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    db.run('DELETE FROM pending_search_requests');
    jest.clearAllMocks();
});

describe('pending search request persistence', () => {
    test('requestSearch stores the request in SQLite', async () => {
        const requestId = await AISearchHandler.requestSearch(stubRequestInteraction(), 'weather in tokyo', 'user asked');

        expect(typeof requestId).toBe('string');
        const row = db.get('SELECT * FROM pending_search_requests WHERE requestId = @id', { id: requestId });
        expect(row).toBeDefined();
        expect(row.query).toBe('weather in tokyo');
        expect(row.channelId).toBe(CHANNEL);
        expect(row.requireApproval).toBe(1);
    });

    test('approval works from persisted state alone (post-restart shape)', async () => {
        // Simulate a request created by a previous process: only the DB row exists.
        db.run(
            `INSERT INTO pending_search_requests (requestId, channelId, query, reason)
             VALUES ('restart-1', @c, 'sqlite vector search', 'testing')`,
            { c: CHANNEL }
        );

        const button = stubButtonInteraction();
        const result = await AISearchHandler.handleSearchApproval('restart-1', button);

        expect(perplexityService.search).toHaveBeenCalledWith('sqlite vector search');
        expect(result.result).toContain('mocked search result');
        expect(button.message.edit).toHaveBeenCalled();
        // Consumed: row removed after execution
        expect(db.get(`SELECT 1 FROM pending_search_requests WHERE requestId = 'restart-1'`)).toBeUndefined();
    });

    test('denial removes the persisted request', async () => {
        const requestId = await AISearchHandler.requestSearch(stubRequestInteraction(), 'some query', 'why');

        const denied = await AISearchHandler.handleSearchDenial(requestId, stubButtonInteraction());
        expect(denied).toBe(true);
        expect(db.get('SELECT 1 FROM pending_search_requests WHERE requestId = @id', { id: requestId })).toBeUndefined();

        // A second click on the same button finds nothing
        const deniedAgain = await AISearchHandler.handleSearchDenial(requestId, stubButtonInteraction());
        expect(deniedAgain).toBe(false);
    });

    test('expired requests are not honored', async () => {
        db.run(
            `INSERT INTO pending_search_requests (requestId, channelId, query, createdAt)
             VALUES ('stale-1', @c, 'old query', datetime('now', '-16 minutes'))`,
            { c: CHANNEL }
        );

        const result = await AISearchHandler.handleSearchApproval('stale-1', stubButtonInteraction());
        expect(result).toBeNull();
        expect(perplexityService.search).not.toHaveBeenCalled();
    });
});
