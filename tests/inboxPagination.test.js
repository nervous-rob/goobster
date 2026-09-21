const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `goobster-inbox-pagination-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const inbox = require('@goobster/core/services/inboxService');
const eventBus = require('@goobster/core/services/eventBusService');

const OWNER = '100000000000000001';
const OTHER = '100000000000000002';

async function insert({ userId = OWNER, archived = false, createdAt = '2026-09-21 12:00:00' } = {}) {
    return db.insert(
        `INSERT INTO inbox_items (userId, kind, title, createdAt, archivedAt)
         VALUES (@userId, 'task', 'Saved result', @createdAt, @archivedAt)`,
        { userId, createdAt, archivedAt: archived ? createdAt : null }
    );
}

beforeEach(async () => { await db.run('DELETE FROM inbox_items'); });

afterAll(async () => {
    await eventBus.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* isolated PG or already gone */ }
    }
});

test('all archived results remain reachable across pages, including timestamp ties', async () => {
    const ids = [];
    for (let i = 0; i < 105; i++) ids.push(await insert({ archived: true }));
    await insert({ userId: OTHER, archived: true });
    await insert();

    const found = [];
    let cursor = null;
    let pages = 0;
    do {
        const page = await inbox.list({ userId: OWNER, archived: true, cursor });
        expect(page.items.length).toBeLessThanOrEqual(50);
        expect(page.unread).toBe(1);
        found.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
        pages += 1;
    } while (cursor && pages < 5);

    expect(pages).toBe(3);
    expect(cursor).toBeNull();
    expect(found).toEqual(ids.reverse());
    expect(new Set(found).size).toBe(105);
});

test('new arrivals and a read cursor row do not shift the next unread page', async () => {
    const oldest = await insert({ createdAt: '2026-09-19 12:00:00' });
    const middle = await insert({ createdAt: '2026-09-20 12:00:00' });
    const latest = await insert();
    // Higher id, but older timestamp: sorting cannot use the id alone.
    const backdated = await insert({ createdAt: '2026-09-18 12:00:00' });
    const first = await inbox.list({ userId: OWNER, unread: true, limit: 2 });
    expect(first.items.map(item => item.id)).toEqual([latest, middle]);

    await inbox.markRead({ userId: OWNER, itemId: middle });
    await insert({ createdAt: '2026-09-22 12:00:00' });
    const second = await inbox.list({ userId: OWNER, unread: true, limit: 2, cursor: first.nextCursor });
    expect(second.items.map(item => item.id)).toEqual([oldest, backdated]);
    expect(second.nextCursor).toBeNull();
    expect(second.unread).toBe(4);
});

test('page cursors cannot select another account and malformed cursors are rejected', async () => {
    const other = await insert({ userId: OTHER });
    for (const cursor of [String(other), '0', '-1', '1.5', '1 OR 1=1', '9007199254740992']) {
        await expect(inbox.list({ userId: OWNER, cursor })).rejects.toMatchObject({ status: 400, code: 'BAD_CURSOR' });
    }
});

test('a cursor remains valid after its row is archived and limits are whole numbers', async () => {
    const oldest = await insert();
    const latest = await insert();
    const first = await inbox.list({ userId: OWNER, limit: 1.9 });
    expect(first.items.map(item => item.id)).toEqual([latest]);
    await inbox.archive({ userId: OWNER, itemId: latest });
    const second = await inbox.list({ userId: OWNER, cursor: first.nextCursor });
    expect(second.items.map(item => item.id)).toEqual([oldest]);
    expect(second.nextCursor).toBeNull();
});
