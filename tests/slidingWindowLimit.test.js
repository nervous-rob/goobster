/**
 * Shared sliding-window rate limit (utils/slidingWindowLimit.js, Phase 5c).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-rate-limit-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { consumeWindow, forgetSubject } = require('@goobster/core/utils/slidingWindowLimit');

const USER = '100000000000000001';
const OTHER = '100000000000000002';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM web_rate_events');
});

describe('consumeWindow', () => {
    test('admits up to max events then rejects', async () => {
        expect(await consumeWindow({ scope: 'web_chat', subject: USER, max: 3, windowMs: 60_000 })).toBe(true);
        expect(await consumeWindow({ scope: 'web_chat', subject: USER, max: 3, windowMs: 60_000 })).toBe(true);
        expect(await consumeWindow({ scope: 'web_chat', subject: USER, max: 3, windowMs: 60_000 })).toBe(true);
        expect(await consumeWindow({ scope: 'web_chat', subject: USER, max: 3, windowMs: 60_000 })).toBe(false);
    });

    test('scopes and subjects are independent', async () => {
        expect(await consumeWindow({ scope: 'web_chat', subject: USER, max: 1, windowMs: 60_000 })).toBe(true);
        expect(await consumeWindow({ scope: 'parlor', subject: USER, max: 1, windowMs: 60_000 })).toBe(true);
        expect(await consumeWindow({ scope: 'web_chat', subject: OTHER, max: 1, windowMs: 60_000 })).toBe(true);
        expect(await consumeWindow({ scope: 'web_chat', subject: USER, max: 1, windowMs: 60_000 })).toBe(false);
    });

    test('forgetSubject drops only that user', async () => {
        await consumeWindow({ scope: 'web_chat', subject: USER, max: 1, windowMs: 60_000 });
        await consumeWindow({ scope: 'web_chat', subject: OTHER, max: 1, windowMs: 60_000 });
        expect(await forgetSubject(USER)).toBe(1);
        expect(await consumeWindow({ scope: 'web_chat', subject: USER, max: 1, windowMs: 60_000 })).toBe(true);
        expect(await consumeWindow({ scope: 'web_chat', subject: OTHER, max: 1, windowMs: 60_000 })).toBe(false);
    });
});
