/**
 * Compare-and-set approval helper (utils/approvalExecutor.js).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-approval-exec-${process.pid}.sqlite`);

const db = require('@goobster/core/db');
const {
    claimPending, finishClaim, releaseClaim, resolveFromPending
} = require('@goobster/core/utils/approvalExecutor');

afterAll(async () => {
    try { await db.closeConnection?.(); } catch { /* best effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.GOOBSTER_DB_PATH + suffix); } catch { /* ignore */ }
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM pending_integration_actions');
});

async function seedPending() {
    return db.insert(
        `INSERT INTO pending_integration_actions (type, guildId, channelId, payload)
         VALUES ('github-issue', '1', '2', '{"title":"x"}')`
    );
}

describe('approvalExecutor', () => {
    test('only one claimPending wins', async () => {
        const id = await seedPending();
        const [a, b] = await Promise.all([
            claimPending(db, { table: 'pending_integration_actions', id, resolvedBy: 'u1' }),
            claimPending(db, { table: 'pending_integration_actions', id, resolvedBy: 'u2' })
        ]);
        const won = [a, b].filter(Boolean);
        expect(won).toHaveLength(1);
        expect(won[0].status).toBe('EXECUTING');
        const row = await db.get(
            'SELECT status FROM pending_integration_actions WHERE id = @id', { id }
        );
        expect(row.status).toBe('EXECUTING');
    });

    test('finishClaim writes the receipt; releaseClaim returns the row to PENDING', async () => {
        const id = await seedPending();
        expect(await claimPending(db, { table: 'pending_integration_actions', id, resolvedBy: 'u' }))
            .toBeTruthy();
        const finished = await finishClaim(db, {
            table: 'pending_integration_actions',
            id,
            status: 'CONFIRMED',
            resolvedBy: 'u',
            resultJson: '{"ok":true}'
        });
        expect(finished.status).toBe('CONFIRMED');
        expect(finished.resultJson).toBe('{"ok":true}');

        const id2 = await seedPending();
        await claimPending(db, { table: 'pending_integration_actions', id: id2, resolvedBy: 'u' });
        await releaseClaim(db, { table: 'pending_integration_actions', id: id2 });
        expect((await db.get(
            'SELECT status FROM pending_integration_actions WHERE id = @id', { id: id2 }
        )).status).toBe('PENDING');
    });

    test('resolveFromPending is a direct deny without EXECUTING', async () => {
        const id = await seedPending();
        const row = await resolveFromPending(db, {
            table: 'pending_integration_actions', id, status: 'CANCELLED', resolvedBy: 'u'
        });
        expect(row.status).toBe('CANCELLED');
        expect(await resolveFromPending(db, {
            table: 'pending_integration_actions', id, status: 'CANCELLED', resolvedBy: 'u'
        })).toBeFalsy();
    });

    test('unknown tables are refused', async () => {
        await expect(claimPending(db, { table: 'users', id: 1 })).rejects.toThrow(/unknown table/);
    });
});
