/**
 * Heartbeat state persistence (services/heartbeatService.js): moods and
 * action cooldowns must survive a process restart via the heartbeat_state
 * table, against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-heartbeat-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const HeartbeatService = require('../services/heartbeatService');

const GUILD_A = '300000000000000001';
const GUILD_B = '300000000000000002';

// The constructor only stores the client reference; no client behavior is
// needed for state persistence tests.
const stubClient = {};

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    db.run('DELETE FROM heartbeat_state');
});

describe('heartbeat state persistence', () => {
    test('moods and cooldowns persist across service instances', () => {
        const first = new HeartbeatService(stubClient);
        const actionTime = Date.now() - 60_000;

        first.moods.set(GUILD_A, 'cozy late-night energy');
        first.lastActionAt.set(GUILD_A, actionTime);
        first._saveState(GUILD_A);

        // Simulates a restart: a fresh instance reads state back from SQLite
        const second = new HeartbeatService(stubClient);
        expect(second.getMood(GUILD_A)).toBe('cozy late-night energy');
        expect(second.lastActionAt.get(GUILD_A)).toBe(actionTime);
    });

    test('state is per-guild and upserts on change', () => {
        const service = new HeartbeatService(stubClient);
        service.moods.set(GUILD_A, 'hyped');
        service._saveState(GUILD_A);
        service.moods.set(GUILD_B, 'quiet');
        service._saveState(GUILD_B);

        service.moods.set(GUILD_A, 'chill');
        service._saveState(GUILD_A);

        const restarted = new HeartbeatService(stubClient);
        expect(restarted.getMood(GUILD_A)).toBe('chill');
        expect(restarted.getMood(GUILD_B)).toBe('quiet');
        expect(db.all('SELECT * FROM heartbeat_state')).toHaveLength(2);
    });

    test('a guild with no persisted state has no mood or cooldown', () => {
        const service = new HeartbeatService(stubClient);
        expect(service.getMood(GUILD_A)).toBeNull();
        expect(service.lastActionAt.has(GUILD_A)).toBe(false);
    });
});
