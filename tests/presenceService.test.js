/**
 * Unit tests for web portal presence (services/presenceService.js): a user
 * is "online" while any of their web sessions was seen inside the window.
 * Presence is derived from web_sessions.lastSeenAt - no new table - so the
 * suite drives it through webSessionService (create/get/touch) and direct
 * backdating. Runs against a throwaway SQLite database, no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-presence-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const webSessionService = require('@goobster/core/services/webSessionService');
const presenceService = require('@goobster/core/services/presenceService');

const ALICE = '500000000000000001';
const BOB = '500000000000000002';

/** Backdate every session row of one user by N minutes. */
async function backdate(userId, minutes) {
    await db.run(
        `UPDATE web_sessions SET lastSeenAt = datetime('now', '-${minutes} minutes')
         WHERE userId = @userId`,
        { userId }
    );
}

beforeEach(async () => {
    await db.run('DELETE FROM web_sessions');
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('presenceService', () => {
    test('a fresh session makes the user online', async () => {
        await webSessionService.create({ userId: ALICE, userName: 'Alice' });
        expect(await presenceService.isOnline(ALICE)).toBe(true);
        expect(await presenceService.isOnline(BOB)).toBe(false);
    });

    test('a stale session drops the user offline on its own', async () => {
        await webSessionService.create({ userId: ALICE, userName: 'Alice' });
        await backdate(ALICE, 10);
        expect(await presenceService.isOnline(ALICE)).toBe(false);
    });

    test('touch() keeps a session warm (the SSE heartbeat path)', async () => {
        const { token } = await webSessionService.create({ userId: ALICE, userName: 'Alice' });
        await backdate(ALICE, 10);
        expect(await presenceService.isOnline(ALICE)).toBe(false);
        await webSessionService.touch(token);
        expect(await presenceService.isOnline(ALICE)).toBe(true);
    });

    test('resolving a session (any API call) also refreshes presence', async () => {
        const { token } = await webSessionService.create({ userId: ALICE, userName: 'Alice' });
        await backdate(ALICE, 10);
        await webSessionService.get(token);
        expect(await presenceService.isOnline(ALICE)).toBe(true);
    });

    test('an expired session never counts, even with a recent lastSeenAt', async () => {
        const { token } = await webSessionService.create({ userId: ALICE, userName: 'Alice' });
        await db.run(
            `UPDATE web_sessions SET expiresAt = datetime('now', '-1 minutes') WHERE userId = @userId`,
            { userId: ALICE }
        );
        expect(await presenceService.isOnline(ALICE)).toBe(false);
        // touch() ignores expired sessions too
        await webSessionService.touch(token);
        expect(await presenceService.isOnline(ALICE)).toBe(false);
    });

    test('onlineIds returns exactly the online subset', async () => {
        await webSessionService.create({ userId: ALICE, userName: 'Alice' });
        await webSessionService.create({ userId: BOB, userName: 'Bob' });
        await backdate(BOB, 10);
        const online = await presenceService.onlineIds([ALICE, BOB, '500000000000000003']);
        expect(online).toEqual(new Set([ALICE]));
        expect(await presenceService.onlineIds([])).toEqual(new Set());
    });
});
