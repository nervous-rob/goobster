/**
 * Unit tests for the SQLite-backed web app session store
 * (services/webSessionService.js) and its /forget-me coverage.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-websession-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const webSessionService = require('../services/webSessionService');
const privacyService = require('../services/privacyService');

const USER = '100000000000000001';
const OTHER = '100000000000000002';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    db.run('DELETE FROM web_sessions');
});

describe('session lifecycle', () => {
    test('create returns a raw token and stores only its hash', () => {
        const { token, expiresAt } = webSessionService.create({ userId: USER, userName: 'rob' });
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(expiresAt).toBeTruthy();

        const row = db.get('SELECT * FROM web_sessions');
        expect(row.userId).toBe(USER);
        expect(row.userName).toBe('rob');
        expect(row.tokenHash).not.toBe(token);
        expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('get resolves a live token and updates lastSeenAt', () => {
        const { token } = webSessionService.create({ userId: USER, userName: 'rob', avatar: 'abc' });
        const session = webSessionService.get(token);
        expect(session).toEqual({ userId: USER, userName: 'rob', avatar: 'abc' });
        expect(db.get('SELECT lastSeenAt FROM web_sessions').lastSeenAt).toBeTruthy();
    });

    test('get rejects unknown and expired tokens', () => {
        expect(webSessionService.get('not-a-token')).toBeNull();
        expect(webSessionService.get(null)).toBeNull();

        const { token } = webSessionService.create({ userId: USER });
        db.run(`UPDATE web_sessions SET expiresAt = datetime('now', '-1 minute')`);
        expect(webSessionService.get(token)).toBeNull();
    });

    test('expired rows are pruned on the next create', () => {
        webSessionService.create({ userId: USER });
        db.run(`UPDATE web_sessions SET expiresAt = datetime('now', '-1 minute')`);
        webSessionService.create({ userId: OTHER });
        const rows = db.all('SELECT userId FROM web_sessions');
        expect(rows).toEqual([{ userId: OTHER }]);
    });

    test('destroy removes exactly the session for that token', () => {
        const { token } = webSessionService.create({ userId: USER });
        webSessionService.create({ userId: OTHER });

        expect(webSessionService.destroy(token)).toBe(true);
        expect(webSessionService.destroy(token)).toBe(false);
        expect(webSessionService.get(token)).toBeNull();
        expect(db.get('SELECT COUNT(*) AS c FROM web_sessions').c).toBe(1);
    });

    test('create requires a snowflake-shaped user id', () => {
        expect(() => webSessionService.create({ userId: 'bob' })).toThrow();
        expect(() => webSessionService.create({})).toThrow();
    });
});

describe('privacy integration', () => {
    test('/forget-me deletes every session for the user and audits clean', () => {
        webSessionService.create({ userId: USER });
        webSessionService.create({ userId: USER });
        webSessionService.create({ userId: OTHER });

        const counts = privacyService.forgetUser({ userId: USER });
        expect(counts.webSessions).toBe(2);

        const audit = privacyService.auditUser({ userId: USER });
        expect(audit.byTable.web_sessions).toBe(0);
        expect(audit.total).toBe(0);

        // The other user's session survives
        expect(db.get('SELECT userId FROM web_sessions').userId).toBe(OTHER);
    });
});
